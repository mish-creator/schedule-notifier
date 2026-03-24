const express = require('express');
const xlsx = require('xlsx');
const axios = require('axios');
const cron = require('node-cron');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ----- Папка для хранения данных -----
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Функции для работы с JSON-хранилищем
function readJson(fileName, defaultValue = {}) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return defaultValue;
  }
}

function writeJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ----- Настройка web-push (генерируем ключи) -----
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
  'mailto:your-email@example.com', // замените на ваш email
  vapidKeys.publicKey,
  vapidKeys.privateKey
);
console.log('Публичный ключ для клиента:', vapidKeys.publicKey);
console.log('Приватный ключ (не теряйте):', vapidKeys.privateKey);

// ----- Функция извлечения даты из имени файла -----
function extractDateFromFilename(filename) {
  // Ищем последовательность цифр (день, месяц, год)
  const match = filename.match(/\d{2,4}[.-]\d{1,2}[.-]\d{1,4}|\d{8}|\d{2}\.\d{2}\.\d{4}/);
  if (!match) return null;
  let dateStr = match[0];
  let day, month, year;
  if (dateStr.includes('.') || dateStr.includes('-')) {
    let parts = dateStr.split(/[.-]/);
    if (parts.length === 3) {
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
    year = dateStr.slice(0,4);
    month = dateStr.slice(4,6);
    day = dateStr.slice(6,8);
  }
  if (year && month && day) {
    return new Date(year, month-1, day);
  }
  return null;
}

// ----- Функция скачивания и парсинга Excel -----
async function downloadAndParseExcel(downloadUrl) {
  try {
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const workbook = xlsx.read(response.data, { type: 'buffer' });
    const result = [];
    workbook.SheetNames.forEach((sheetName, index) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.length >= 3) {
          const room = row[0] ? row[0].toString().trim() : '';
          const group = row[1] ? row[1].toString().trim() : '';
          const teacher = row[2] ? row[2].toString().trim() : '';
          if (group !== '') {
            result.push({
              pair_number: index + 1,
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

// ----- Google Drive API -----
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'ВАШ_API_КЛЮЧ';
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

// ----- Сохранение расписания для группы -----
function saveScheduleForGroup(date, group, scheduleData) {
  const fileName = `schedule_${date}_${group}.json`;
  writeJson(fileName, scheduleData);
}

// ----- Получение расписания для группы -----
function getScheduleForGroup(date, group) {
  const fileName = `schedule_${date}_${group}.json`;
  return readJson(fileName, []);
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

  // Функция обработки одного файла
  async function processFile(file, dateLabel) {
    if (!file) return null;
    const url = getDirectDownloadUrl(file.id);
    const scheduleData = await downloadAndParseExcel(url);
    if (!scheduleData) return null;

    const fileDate = extractDateFromFilename(file.name);
    const dateStr = fileDate.toISOString().slice(0,10);

    // Группируем по группам и сохраняем для каждой
    const groupsMap = new Map();
    for (const item of scheduleData) {
      const group = item.group_name;
      if (!groupsMap.has(group)) groupsMap.set(group, []);
      groupsMap.get(group).push({
        pair_number: item.pair_number,
        room: item.room,
        teacher: item.teacher
      });
    }
    for (const [group, pairs] of groupsMap.entries()) {
      saveScheduleForGroup(dateStr, group, pairs);
    }

    // Вычисляем хеш для сравнения (по всем данным, чтобы отследить изменение)
    const hash = require('crypto').createHash('md5').update(JSON.stringify(scheduleData)).digest('hex');
    return hash;
  }

  // Получаем старые хеши
  const lastChecks = readJson('last_checks.json', { today_hash: '', tomorrow_hash: '' });
  const oldTodayHash = lastChecks.today_hash;
  const oldTomorrowHash = lastChecks.tomorrow_hash;

  const newTodayHash = todayFile ? await processFile(todayFile, 'today') : null;
  const newTomorrowHash = tomorrowFile ? await processFile(tomorrowFile, 'tomorrow') : null;

  // Обновляем хеши
  const newLastChecks = {
    today_hash: newTodayHash || '',
    tomorrow_hash: newTomorrowHash || ''
  };
  writeJson('last_checks.json', newLastChecks);

  // Отправляем уведомления при изменениях
  if (newTodayHash && newTodayHash !== oldTodayHash) {
    sendNotificationToAll('Расписание на сегодня обновлено!');
  }
  if (newTomorrowHash && newTomorrowHash !== oldTomorrowHash) {
    sendNotificationToAll('Расписание на завтра обновлено!');
  }
}

// ----- Отправка уведомлений всем подписанным клиентам -----
async function sendNotificationToAll(message) {
  const subscriptions = readJson('subscriptions.json', []);
  const payload = JSON.stringify({ title: 'Обновление расписания', body: message });
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      console.error('Ошибка отправки уведомления:', err);
      if (err.statusCode === 410) {
        // Подписка истекла, удаляем
        const updated = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        writeJson('subscriptions.json', updated);
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
  let subscriptions = readJson('subscriptions.json', []);
  // Заменяем, если уже есть
  const index = subscriptions.findIndex(s => s.endpoint === subscription.endpoint);
  if (index !== -1) {
    subscriptions[index] = subscription;
  } else {
    subscriptions.push(subscription);
  }
  writeJson('subscriptions.json', subscriptions);
  res.status(201).json({});
});

app.get('/api/schedule/:group/:date', (req, res) => {
  const group = req.params.group;
  const date = req.params.date;
  const schedule = getScheduleForGroup(date, group);
  res.json(schedule);
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