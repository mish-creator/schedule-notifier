const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const xlsx = require('xlsx');
const axios = require('axios');
const cron = require('node-cron');
const webpush = require('web-push');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public')); // для статических файлов клиента

// ----- Настройка web-push (сгенерируем ключи позже) -----
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
  'mailto:your-email@example.com', // замените на свой email
  vapidKeys.publicKey,
  vapidKeys.privateKey
);
console.log('Публичный ключ для клиента:', vapidKeys.publicKey);
console.log('Приватный ключ (не теряйте):', vapidKeys.privateKey);

// ----- База данных SQLite -----
const db = new sqlite3.Database('./schedule.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    auth TEXT,
    p256dh TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    pair_number INTEGER,
    room TEXT,
    group_name TEXT,
    teacher TEXT,
    UNIQUE(date, pair_number, group_name)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS last_checks (
    id INTEGER PRIMARY KEY CHECK (id=1),
    today_hash TEXT,
    tomorrow_hash TEXT
  )`);
  db.run(`INSERT OR IGNORE INTO last_checks (id, today_hash, tomorrow_hash) VALUES (1, '', '')`);
});

// ----- Функция извлечения даты из имени файла -----
function extractDateFromFilename(filename) {
  // Ищем последовательность цифр (день, месяц, год)
  const match = filename.match(/\d{2,4}[.-]\d{1,2}[.-]\d{1,4}|\d{8}|\d{2}\.\d{2}\.\d{4}/);
  if (!match) return null;
  let dateStr = match[0];
  // Пытаемся распарсить
  let day, month, year;
  if (dateStr.includes('.') || dateStr.includes('-')) {
    let parts = dateStr.split(/[.-]/);
    if (parts.length === 3) {
      // Предполагаем, что первая часть — день, вторая — месяц, третья — год или наоборот
      if (parts[0].length === 4) {
        year = parts[0];
        month = parts[1];
        day = parts[2];
      } else {
        day = parts[0];
        month = parts[1];
        year = parts[2];
      }
    }
  } else if (dateStr.length === 8) {
    // формат YYYYMMDD
    year = dateStr.slice(0,4);
    month = dateStr.slice(4,6);
    day = dateStr.slice(6,8);
  }
  if (year && month && day) {
    return new Date(year, month-1, day);
  }
  return null;
}

// ----- Функция скачивания и парсинга файла по ссылке -----
async function downloadAndParseExcel(downloadUrl) {
  try {
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const workbook = xlsx.read(response.data, { type: 'buffer' });
    const result = [];
    workbook.SheetNames.forEach((sheetName, index) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      // rows — массив массивов, без заголовков
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.length >= 3) {
          const room = row[0] ? row[0].toString().trim() : '';
          const group = row[1] ? row[1].toString().trim() : '';
          const teacher = row[2] ? row[2].toString().trim() : '';
          if (group !== '') { // пропускаем пустые строки
            result.push({
              pair_number: index + 1, // номер пары = номер листа + 1
              room,
              group_name: group,
              teacher
            });
          }
        }
      }
    });
    return result;
  } catch (err) {
    console.error('Ошибка при скачивании/парсинге:', err.message);
    return null;
  }
}

// ----- Получение прямых ссылок на файлы из папки -----
// Упрощённый подход: предполагаем, что файлы имеют постоянные имена с датами, и мы сами формируем URL
// Но для универсальности попробуем спарсить страницу папки (только если папка открыта)
// Лучше всего, если вы будете указывать ссылки на файлы вручную через переменные окружения.
// Сделаем так: зададим ID папки и будем использовать Google Drive API без авторизации (но это нестабильно).
// Вместо этого, я предлагаю вам задать прямые ссылки на файлы в переменных окружения.
// Для простоты, я сделаю так: сервер будет ожидать, что в папке лежат файлы, имена которых содержат дату.
// Чтобы получить список файлов, используем Google Drive API v3 с публичным доступом.
// Вам нужно будет получить API ключ Google (бесплатно) и включить Drive API.

// ----- Настройка Google Drive API -----
// 1. Зайдите на https://console.cloud.google.com/
// 2. Создайте проект, включите Google Drive API
// 3. Создайте API ключ (ограничьте его для использования только Drive API)
// 4. Вставьте ключ в переменную ниже
const GOOGLE_API_KEY = 'ВАШ_API_КЛЮЧ'; // замените
const FOLDER_ID = '1bdHCozxsjzy7BVd76sBTTK_ckhZ78wbo'; // ID вашей папки

async function getFileListInFolder() {
  const url = `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents&key=${GOOGLE_API_KEY}&fields=files(id,name)`;
  try {
    const response = await axios.get(url);
    return response.data.files;
  } catch (err) {
    console.error('Ошибка получения списка файлов:', err.message);
    return [];
  }
}

function getDirectDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// ----- Основная функция проверки расписания -----
async function checkAndUpdateSchedule() {
  console.log('Проверка расписания...');
  const files = await getFileListInFolder();
  if (!files.length) return;

  const today = new Date();
  today.setHours(0,0,0,0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let todayFile = null, tomorrowFile = null;

  for (const file of files) {
    const fileDate = extractDateFromFilename(file.name);
    if (!fileDate) continue;
    if (fileDate.getTime() === today.getTime()) todayFile = file;
    if (fileDate.getTime() === tomorrow.getTime()) tomorrowFile = file;
  }

  if (!todayFile && !tomorrowFile) {
    console.log('Файлы на сегодня/завтра не найдены');
    return;
  }

  // Функция обработки одного файла
  async function processFile(file, dateLabel) {
    if (!file) return null;
    const url = getDirectDownloadUrl(file.id);
    const scheduleData = await downloadAndParseExcel(url);
    if (!scheduleData) return null;

    // Сохраняем в БД, предварительно очистив старые записи за эту дату
    const dateStr = extractDateFromFilename(file.name).toISOString().slice(0,10);
    await db.run(`DELETE FROM schedule WHERE date = ?`, [dateStr]);
    const stmt = db.prepare(`INSERT INTO schedule (date, pair_number, room, group_name, teacher) VALUES (?, ?, ?, ?, ?)`);
    for (const item of scheduleData) {
      stmt.run(dateStr, item.pair_number, item.room, item.group_name, item.teacher);
    }
    stmt.finalize();

    // Вычисляем хеш для сравнения
    const hash = require('crypto').createHash('md5').update(JSON.stringify(scheduleData)).digest('hex');
    return hash;
  }

  // Получаем старые хеши
  db.get(`SELECT today_hash, tomorrow_hash FROM last_checks WHERE id = 1`, async (err, row) => {
    if (err) return;
    const oldTodayHash = row.today_hash;
    const oldTomorrowHash = row.tomorrow_hash;

    const newTodayHash = todayFile ? await processFile(todayFile, 'today') : null;
    const newTomorrowHash = tomorrowFile ? await processFile(tomorrowFile, 'tomorrow') : null;

    // Обновляем хеши
    db.run(`UPDATE last_checks SET today_hash = ?, tomorrow_hash = ? WHERE id = 1`, [newTodayHash || '', newTomorrowHash || '']);

    // Отправляем уведомления при изменениях
    if (newTodayHash && newTodayHash !== oldTodayHash) {
      sendNotificationToAll('Расписание на сегодня обновлено!');
    }
    if (newTomorrowHash && newTomorrowHash !== oldTomorrowHash) {
      sendNotificationToAll('Расписание на завтра обновлено!');
    }
  });
}

// ----- Отправка уведомлений всем подписанным клиентам -----
async function sendNotificationToAll(message) {
  const subscriptions = await new Promise((resolve) => {
    db.all(`SELECT endpoint, auth, p256dh FROM subscriptions`, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
  const payload = JSON.stringify({ title: 'Обновление расписания', body: message });
  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        auth: sub.auth,
        p256dh: sub.p256dh
      }
    };
    try {
      await webpush.sendNotification(pushSubscription, payload);
    } catch (err) {
      console.error('Ошибка отправки уведомления:', err);
      if (err.statusCode === 410) {
        // Подписка истекла, удаляем
        db.run(`DELETE FROM subscriptions WHERE endpoint = ?`, [sub.endpoint]);
      }
    }
  }
}

// ----- API для клиента -----
app.get('/api/public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  const endpoint = subscription.endpoint;
  const auth = subscription.keys.auth;
  const p256dh = subscription.keys.p256dh;
  db.run(`INSERT OR REPLACE INTO subscriptions (endpoint, auth, p256dh) VALUES (?, ?, ?)`, [endpoint, auth, p256dh], (err) => {
    if (err) return res.status(500).send('Ошибка сохранения');
    res.status(201).json({});
  });
});

app.get('/api/schedule/:group/:date', (req, res) => {
  const group = req.params.group;
  const date = req.params.date;
  db.all(`SELECT pair_number, room, teacher FROM schedule WHERE date = ? AND group_name = ? ORDER BY pair_number`, [date, group], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Запуск периодической проверки каждый час
cron.schedule('0 * * * *', () => {
  checkAndUpdateSchedule();
});

// При старте сервера тоже проверим
setTimeout(() => {
  checkAndUpdateSchedule();
}, 5000);

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});