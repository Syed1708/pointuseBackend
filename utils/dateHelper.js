// backend/utils/dateHelper.js
const crypto = require('crypto');

// 1. Find Monday from any YYYY-MM-DD string [3]
const getMonday = (dateStr) => {
  const date = new Date(dateStr + "T00:00:00");
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const targetDate = new Date(date.setDate(diff));
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, "0");
  const dayStr = String(targetDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${dayStr}`;
};

// 2. Get weekday name from any YYYY-MM-DD string
const getWeekdayKey = (dateStr) => {
  const date = new Date(dateStr + "T00:00:00");
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return weekdays[date.getDay()];
};

// 3. Get ISO Week Number
const getWeekNumber = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};


// 4. Format single day date (e.g. "22-06")
const getDayDateString = (mondayString, offsetDays) => {
  const date = new Date(mondayString + "T00:00:00");
  date.setDate(date.getDate() + offsetDays);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}`;
};

// 5. Format full range (e.g. "22-06-2026 to 28-06-2026")
const getWeekRangeString = (mondayString) => {
  const start = new Date(mondayString + "T00:00:00");
  const end = new Date(mondayString + "T00:00:00");
  end.setDate(end.getDate() + 6);
  
  const formatDate = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${d.getFullYear()}`;
  };
  return `${formatDate(start)} to ${formatDate(end)}`;
};

// 6. Get YYYY-MM-DD string of current system time
const getLocalDateString = () => {
  return new Date().toLocaleDateString('fr-CA');
};



module.exports = {
  getMonday,
  getWeekdayKey,
  getWeekNumber,
  getDayDateString,
  getWeekRangeString,
  getLocalDateString
};