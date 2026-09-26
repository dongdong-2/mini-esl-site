/* ============================================================
 * utils.js — 基础工具函数
 * 智能电子价签蓝牙控制中心
 * ============================================================ */

/** 16进制字符串 → Uint8Array 字节数组 */
function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('16进制数据长度必须为偶数');
  }
  const bytes = [];
  for (let c = 0; c < clean.length; c += 2) {
    bytes.push(parseInt(clean.substr(c, 2), 16));
  }
  return new Uint8Array(bytes);
}

/** 字节数组 → 16进制字符串 */
function bytesToHex(data) {
  return new Uint8Array(data).reduce((memo, i) => memo + ('0' + i.toString(16)).slice(-2), '');
}

/** 数字 → 16进制字符串（定宽，bytes 指定字节数） */
function intToHex(intIn, bytes = 4) {
  return (intIn >>> 0).toString(16).padStart(bytes * 2, '0');
}

/** 延迟 Promise */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 获取当前时间对象（设备协议需要：unix 时间戳、年月日、星期） */
function getUnixTime() {
  const unixNow = Math.round(Date.now() / 1000) - new Date().getTimezoneOffset() * 60;
  const date = new Date((unixNow + new Date().getTimezoneOffset() * 60) * 1000);
  return {
    unixNow,
    localeTimeString: date.toLocaleTimeString(),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    week: date.getDay() || 7
  };
}

/** 根据指定日期构造时间对象（用于设定任意时间） */
function getUnixTimeForDate(date) {
  const unixNow = Math.round(date.getTime() / 1000) - new Date().getTimezoneOffset() * 60;
  return {
    unixNow,
    localeTimeString: date.toLocaleTimeString(),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    week: date.getDay() || 7
  };
}

