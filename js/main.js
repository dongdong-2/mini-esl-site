/* ============================================================
 * main.js — 智能电子价签蓝牙控制中心 · 业务逻辑
 * ------------------------------------------------------------
 * 功能：蓝牙连接、指令下发、图片上传、图像处理调度、
 *       设备激活、时间/时区/刷新模式设置、迷你价签模板、
 *       演示模式（无蓝牙硬件时体验完整流程）
 * ============================================================ */

/* ---------- 蓝牙服务 / 特征 UUID ---------- */
const UUID = {
  CMD_SERVICE: '00001f10-0000-1000-8000-00805f9b34fb',          // 指令串口服务
  CMD_CHAR:    '00001f1f-0000-1000-8000-00805f9b34fb',          // 指令串口特征
  IMG_SERVICE: '13187b10-eba9-a3ba-044e-83d3217d9a38',          // 图片服务
  IMG_CHAR:    '4b646063-6264-f3a7-8941-e65356ea82fe',          // 图片特征
  OTA_SERVICE: '0000fef5-0000-1000-8000-00805f9b34fb'           // OTA 服务（预留）
};

/* 设备名称前缀（Nordic NRF 系列价签） */
const DEVICE_NAME_PREFIX = 'NRF';

/* ---------- 连接状态 ---------- */
let bleDevice = null;
let gattServer = null;
let EpdImgCharacteristic = null;
let RxTxCmdCharacteristic = null;
let reconnectTrys = 0;
let imageUploadInProgress = false;

const isDemoMode = () => !('bluetooth' in navigator);

/* ---------- 系统日志 ---------- */
function addLog(message) {
  const log = document.getElementById('log');
  if (!log) return;
  const timestamp = new Date().toLocaleTimeString();
  log.value += `[${timestamp}] ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

/* ---------- GB2312 编码（设备指令含中文时使用） ---------- */
function encodeToGb2312(str) {
  if (!str) return '';
  return urlEncode(str);
}

function urlEncode(strInput) {
  let str = strInput.replace(/(script)/gi, '');
  str = str.replace(/(javascript)/gi, '');
  str = str.replace(/(alert)/gi, '');
  str = str.replace(/(style)/gi, '');
  return urlEncodeV2(str);
}

function urlEncodeV2(str) {
  let ret = '';
  for (let i = 0; i < str.length; i++) {
    const chr = str.charAt(i);
    const c = strToAsc(chr);
    if (parseInt('0x' + c) > 0x7f) {
      ret += c.slice(0, 2) + c.slice(-2);
    } else {
      ret += parseInt('0x' + c) < 0x10 ? '0' + c.toString(16) : c.toString(16);
    }
  }
  return ret;
}

function strToAsc(str) {
  const n = unicodeToAnsi(str.charCodeAt(0));
  return n.toString(16).toUpperCase();
}

function unicodeToAnsi(chrCode) {
  let chrHex = chrCode.toString(16);
  chrHex = '000' + chrHex.toUpperCase();
  chrHex = chrHex.substr(chrHex.length - 4);
  const i = getUniCode().indexOf(chrHex);
  if (i !== -1) {
    chrHex = getAnsiCodeChr().substr(i, 4);
  }
  return parseInt(chrHex, 16);
}

/* ---------- 连接管理 ---------- */

function resetVariables() {
  gattServer = null;
  EpdImgCharacteristic = null;
  RxTxCmdCharacteristic = null;
}

async function handleError(error) {
  console.log(error);
  resetVariables();
  if (bleDevice == null) return;
  if (reconnectTrys <= 5) {
    reconnectTrys++;
    addLog('连接异常，尝试重连 (' + reconnectTrys + '/5)...');
    await connect();
  } else {
    addLog('无法连接设备，已中止');
    reconnectTrys = 0;
  }
}

/** 连接 / 断开 主入口（连接按钮） */
async function preConnect() {
  if (isDemoMode()) {
    addLog('当前浏览器不支持 Web Bluetooth，已进入演示模式。');
    addLog('演示模式模拟连接成功（无法操作真实硬件）。');
    setConnectedUI(true);
    return;
  }

  const connectBtn = document.getElementById('connectbutton');
  const statusIndicator = document.querySelector('.status-indicator');

  if (gattServer != null && gattServer.connected) {
    if (bleDevice != null && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
  } else {
    connectBtn.innerHTML = '<div class="loading"></div>正在连接...';
    connectBtn.disabled = true;
    try {
      reconnectTrys = 0;
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [
          UUID.CMD_SERVICE, UUID.CMD_SERVICE, UUID.OTA_SERVICE, UUID.IMG_SERVICE
        ],
        acceptAllDevices: false
      });
      bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
      await connect();
      setConnectedUI(true);
      addLog('✓ 蓝牙连接成功');
    } catch (error) {
      connectBtn.innerHTML = '连接设备';
      connectBtn.disabled = false;
      addLog('✗ 连接失败: ' + error.message);
      await handleError(error);
    }
  }
}

function setConnectedUI(connected) {
  const connectBtn = document.getElementById('connectbutton');
  const statusIndicator = document.querySelector('.status-indicator');
  if (connectBtn) {
    connectBtn.innerHTML = connected ? '<span class="status-indicator connected"></span>断开' : '<span class="status-indicator"></span>连接设备';
  }
  if (statusIndicator) {
    statusIndicator.classList.toggle('connected', connected);
  }
}

function onDisconnected() {
  resetVariables();
  addLog('连接已断开');
  setConnectedUI(false);
}

async function connect() {
  if (EpdImgCharacteristic == null) {
    addLog('正在连接: ' + bleDevice.name + ' (' + bleDevice.id + ')');
    gattServer = await bleDevice.gatt.connect();
    addLog('> 找到 GATT 服务器');

    // 图片服务
    const imgService = await gattServer.getPrimaryService(UUID.IMG_SERVICE);
    addLog('> 找到 IMG 可用服务');
    EpdImgCharacteristic = await imgService.getCharacteristic(UUID.IMG_CHAR);
    await EpdImgCharacteristic.startNotifications();
    addLog('> IMG 服务已连接');

    // 指令串口服务
    await connectRXTX();
  }
}

async function connectRXTX() {
  if (!gattServer) return;
  const service = await gattServer.getPrimaryService(UUID.CMD_SERVICE);
  addLog('> 找到串口服务');
  RxTxCmdCharacteristic = await service.getCharacteristic(UUID.CMD_CHAR);
  addLog('> 串口服务已连接');
}

async function reConnect() {
  if (isDemoMode()) {
    addLog('演示模式：重新连接成功');
    return;
  }
  if (bleDevice != null && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  resetVariables();
  addLog('重新连接...');
  await delay(300);
  try {
    await connect();
    setConnectedUI(true);
    addLog('✓ 重新连接成功');
  } catch (e) {
    addLog('✗ 重新连接失败: ' + e.message);
  }
}

/* ---------- 指令发送 ---------- */

async function sendImgCommand(cmd) {
  if (isDemoMode()) {
    addLog('  [演示] IMG: ' + bytesToHex(cmd));
    return;
  }
  if (EpdImgCharacteristic) {
    await EpdImgCharacteristic.writeValueWithResponse(cmd);
  } else {
    throw new Error('IMG 服务不可用，请重新连接蓝牙设备');
  }
}

async function rxTxSendCommand(cmd) {
  if (isDemoMode()) {
    addLog('  [演示] CMD: ' + bytesToHex(cmd));
    return;
  }
  if (RxTxCmdCharacteristic) {
    await RxTxCmdCharacteristic.writeValueWithResponse(cmd);
  } else {
    throw new Error('串口服务不可用，请重新连接蓝牙设备');
  }
}

async function triggerRxTxCmd(cmd) {
  addLog('发送指令: ' + cmd);
  await rxTxSendCommand(hexToBytes(cmd));
}

async function triggerShowCmd(cmd) {
  await triggerRxTxCmd(cmd);
  await delay(150);
  await triggerRxTxCmd('e2');
}

async function triggerEpdCmd(cmd) {
  addLog('发送指令: ' + cmd);
  await sendImgCommand(hexToBytes(cmd));
}

/* ---------- 图片上传与画布处理 ---------- */

/** 上传图片文件 → 画布（缩放至画布尺寸）→ 抖动处理 */
function updateImageToCanvas(fileInput, canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (fileInput && fileInput.files.length > 0) {
    const file = fileInput.files[0];
    const image = new Image();
    image.onload = function () {
      URL.revokeObjectURL(this.src);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);
      convertDithering(canvas, document.getElementById('dithering').value, document.getElementById('threshold').value);
      addLog('✓ 图片加载并处理完成: ' + file.name);
    };
    image.onerror = function () {
      addLog('✗ 图片加载失败');
    };
    image.src = URL.createObjectURL(file);
  }
}

/** 重新按当前算法处理画布 */
function reprocessCanvas() {
  const canvas = document.getElementById('canvas');
  convertDithering(canvas, document.getElementById('dithering').value, document.getElementById('threshold').value);
  addLog('✓ 已按当前参数重新处理');
}

function clearCanvas() {
  if (confirm('确认清除画布内容？')) {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    addLog('✓ 画布已清空');
  }
}

/** 分块发送图片数据（IMG 协议） */
async function sendBufferData(value, type = 'bw') {
  addLog('开始发送图片模式:' + type + ', 大小 ' + (value.length / 2 / 1024).toFixed(2) + 'KB');
  let code = 'ff';
  if (type === 'bwr') code = '00';
  const step = 480;
  let partIndex = 0;
  for (let i = 0; i < value.length; i += step) {
    let part_len = step;
    if (i + step > value.length) part_len = value.length - i;
    addLog('正在发送第' + (partIndex + 1) + '块. 块大小: ' + (part_len / 2 + 4) + 'byte. 起始位置: ' + (i / 2));
    await sendImgCommand(hexToBytes('03' + code + intToHex(i / 2, 2) + value.substring(i, i + step)));
    partIndex += 1;
  }
}

/** 将画布上传至设备（黑白 + 三色双层数据） */
async function uploadImageCanvas(canvas, imageId = 0, scale = 1) {
  if (EpdImgCharacteristic == null && !isDemoMode()) {
    addLog('✗ 未连接设备，请先连接');
    return;
  }
  if (imageUploadInProgress) {
    addLog('图片正在上传，请勿重复点击');
    return;
  }

  const channel = Number(imageId);
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
    addLog('✗ 图片通道必须是 0–255 的整数');
    return;
  }

  imageUploadInProgress = true;
  const startTime = Date.now();
  addLog('开始上传画布 → 通道 ' + channel + ' ...');

  try {
    // 设备协议的通道号固定占 1 字节。直接拼接数字 0 会得到奇数长度的
    // "800"，严格的 hexToBytes() 会在第一条上传指令处中止。
    const imageIdHex = intToHex(channel, 1);
    await sendImgCommand(hexToBytes('80' + imageIdHex));
    await sendImgCommand(hexToBytes('0000'));
    await sendImgCommand(hexToBytes('020000'));

    await sendBufferData(bytesToHex(canvas2bytes(canvas, canvas.width, canvas.height, 'bw', scale)), 'bw');
    await sendBufferData(bytesToHex(canvas2bytes(canvas, canvas.width, canvas.height, 'bwr', scale)), 'bwr');

    await sendImgCommand(hexToBytes('0101'));
    await channelImage(channel);
    addLog('✓ 刷新完成，耗时 ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's');
  } catch (error) {
    addLog('✗ 图片上传失败: ' + (error && error.message ? error.message : error));
    console.error('图片上传失败', error);
  } finally {
    imageUploadInProgress = false;
  }
}

/** 切换显示通道 */
async function channelImage(imageId) {
  await triggerRxTxCmd(encodeToGb2312('$IMG(' + imageId + ',0)'));
  await rxTxSendCommand(hexToBytes('E2'));
}

/** 生成完整图片数据包（用于保存 .bin 文件） */
function getBufferData(value, type, imgInterval) {
  addLog('生成数据包:' + type + ', 大小 ' + (value.length / 2 / 1024).toFixed(2) + 'KB');
  let code = 'ff';
  if (type === 'bwr') code = '00';
  const step = (imgInterval - 4) * 2;

  let dat = '';
  dat += '8000'.padEnd(imgInterval * 2, '0');
  dat += '0000'.padEnd(imgInterval * 2, '0');
  dat += '020000'.padEnd(imgInterval * 2, '0');
  for (let i = 0; i < value.length; i += step) {
    dat += '03' + code + intToHex(i / 2, 2) + value.substring(i, i + step);
  }
  if (dat.length % (imgInterval * 2) !== 0) {
    dat = dat.padEnd(dat.length + imgInterval * 2 - dat.length % (imgInterval * 2), '0');
  }
  dat += '0101'.padEnd(imgInterval * 2, '0');
  return dat;
}

/** 保存图片数据为 .bin 文件 */
function imageSaveAs(imgInterval = 256) {
  const canvas = document.getElementById('canvas');
  const bin = hexToBytes(getBufferData(bytesToHex(canvas2bytes(canvas, canvas.width, canvas.height, 'bw')), 'bw', imgInterval));
  downloadBlob(bin, 'img_data.bin', 'application/octet-stream');
  addLog('✓ 已保存为 img_data.bin (' + bin.length + ' 字节)');
}

function downloadBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- 设备功能：时间 / 时区 / 刷新模式 ---------- */

async function setTime() {
  const { unixNow, localeTimeString, year, month, day, week } = getUnixTime();
  addLog('时间设置为: ' + localeTimeString + ' : dd' + intToHex(unixNow, 4));
  await rxTxSendCommand(hexToBytes('dd' +
    [intToHex(unixNow, 4), intToHex(year, 2), intToHex(month, 1), intToHex(day, 1), intToHex(week, 1)].join('')));
  await delay(150);
  await rxTxSendCommand(hexToBytes('e2'));
}

async function setPixTime() {
  const val = document.getElementById('trip-start').value;
  if (!val) { addLog('请先选择日期时间'); return; }
  const { unixNow, localeTimeString, year, month, day, week } = getUnixTimeForDate(new Date(val));
  addLog('时间设置为: ' + localeTimeString + ' : dd' + intToHex(unixNow, 4));
  await rxTxSendCommand(hexToBytes('dd' +
    [intToHex(unixNow, 4), intToHex(year, 2), intToHex(month, 1), intToHex(day, 1), intToHex(week, 1)].join('')));
  await delay(150);
  await rxTxSendCommand(hexToBytes('e2'));
}

async function modifyTimeZone() {
  const timezone = document.getElementById('timezone').value;
  const tzHex = intToHex(parseInt(timezone), 1);
  addLog('修改时区为: ' + tzHex + ' (UTC+' + timezone + ')');
  await rxTxSendCommand(hexToBytes('e4' + tzHex));
  await delay(150);
  await rxTxSendCommand(hexToBytes('e2'));
}

async function modifyRefreshMode() {
  const mode = document.getElementById('refresh_mode').value;
  const modeHex = intToHex(parseInt(mode), 1);
  addLog('修改刷新模式为: ' + modeHex);
  await rxTxSendCommand(hexToBytes('e5' + modeHex));
  await delay(150);
  await rxTxSendCommand(hexToBytes('e2'));
}

/* ---------- 设备激活 ---------- */

async function devReg() {
  const regCode = document.getElementById('reg_code').value;
  if (!regCode) { alert('请输入激活码'); return; }
  addLog('→ 设备激活: ' + regCode);
  await rxTxSendCommand(hexToBytes('ef' + regCode));
  await delay(150);
  await rxTxSendCommand(hexToBytes('e2'));
}

/* ---------- 迷你价签模板 ---------- */

/** 模板专用位图打包（注意索引方向与主打包不同） */
function canvas2bytesV(canvas, t_width, t_height, type = 'bw') {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, t_width, t_height);
  const data = imageData.data;

  const arr = [];
  let buffer = [];
  const height = t_height;
  const width = Math.floor((t_width + 7) / 8) * 8;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (t_width * 4 * (height - y - 1)) + (t_width - x - 1 - 18) * 4;
      if (type !== 'bwr') {
        buffer.push(data[index] > 0 ? 1 : 0);
      } else {
        buffer.push(data[index] > 0 && data[index + 1] === 0 && data[index + 2] === 0 ? 1 : 0);
      }
      if (buffer.length === 8) {
        arr.push(parseInt(buffer.join(''), 2));
        buffer = [];
      }
    }
  }
  return arr;
}

function strLen(str) {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    len += str.charCodeAt(i) > 127 ? 2 : 1;
  }
  return len;
}

/**
 * 自适应字号绘制文本
 * 文本超出 maxWidth 时逐级缩小字号；缩至 minFontSize 仍放不下则截断并追加省略号
 * @returns {string} 实际绘制的文本
 */
function drawFitText(ctx, text, x, y, maxWidth, maxFontSize, minFontSize, fontFamily, fontPrefix) {
  fontPrefix = fontPrefix || '';
  let size = maxFontSize;
  const font = (s) => fontPrefix + s + 'px ' + fontFamily;
  ctx.font = font(size);
  // 1. 优先缩小字号
  while (size > minFontSize && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = font(size);
  }
  let display = text;
  // 2. 最小字号仍放不下 → 截断 + 省略号
  if (ctx.measureText(text).width > maxWidth) {
    const ellipsis = '…';
    while (display.length > 1 && ctx.measureText(display + ellipsis).width > maxWidth) {
      display = display.slice(0, -1);
    }
    display += ellipsis;
  }
  ctx.fillText(display, x, y);
  return display;
}

/**
 * 居中绘制自适应文本（用于红色顶条等需要水平居中的场景）
 * 调用前需设置 ctx.textAlign='center'、ctx.textBaseline='middle'，函数内会保持
 * @param {string} fontPrefix 字体前缀，如 'bold '（加粗），默认空
 */
function drawFitTextCenter(ctx, text, x, y, maxWidth, maxFontSize, minFontSize, fontFamily, fontPrefix) {
  fontPrefix = fontPrefix || '';
  let size = maxFontSize;
  const font = (s) => fontPrefix + s + 'px ' + fontFamily;
  ctx.font = font(size);
  while (size > minFontSize && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = font(size);
  }
  let display = text;
  if (ctx.measureText(text).width > maxWidth) {
    const ellipsis = '…';
    while (display.length > 1 && ctx.measureText(display + ellipsis).width > maxWidth) {
      display = display.slice(0, -1);
    }
    display += ellipsis;
  }
  ctx.fillText(display, x, y);
  return display;
}

/** 迷你价签画布模板实时渲染 */
function canvasRefresh() {
  const canvas = document.getElementById('text_data_canvas_1');
  if (!canvas) return;
  const textNames = document.getElementById('text_name').value.split(',');
  const textMoney = document.getElementById('text_money').value;
  const textUnit = document.getElementById('text_unit').value;
  const textRemarks = document.getElementById('text_remarks').value;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';

  if (textNames.length >= 1) {
    ctx.fillStyle = '#000000';
    // 品牌名：右侧有第二段文本时只占左侧区域(112px)，否则可占满整行(246px)
    const brandMaxWidth = textNames.length >= 2 ? 112 : 246;
    drawFitText(ctx, textNames[0], 0, 30, brandMaxWidth, 30, 12, '微软雅黑');
  }
  if (textNames.length >= 2) {
    ctx.font = '16px 宋体';
    ctx.fillStyle = '#000000';
    drawFitText(ctx, textNames[1], 120, 30, 130, 16, 10, '宋体');
  }
  if (textNames.length >= 3) {
    ctx.font = '20px 微软雅黑';
    ctx.fillStyle = '#000000';
    drawFitText(ctx, textNames[2], 180, 20, 70, 20, 10, '微软雅黑');
  }

  // 零售价
  ctx.font = '16px 宋体';
  ctx.fillStyle = '#000000';
  ctx.fillText('零售价', 10, 70);

  const priceInt = parseInt(parseFloat(textMoney));
  let priceDec = Math.round((parseFloat(textMoney) - priceInt) * 100);
  if (priceDec < 10) priceDec = '0' + priceDec;
  let offset = 60;
  const fontSize = textMoney >= 1000 ? 45 : 60;

  ctx.font = fontSize + 'px 微软雅黑';
  ctx.fillStyle = '#FF0000';
  if (textMoney > 100) ctx.fillText(priceInt + '.', offset, 100);
  else if (textMoney > 10) ctx.fillText(priceInt + '.', offset + 35, 100);
  else if (textMoney > 0) ctx.fillText(priceInt + '.', offset + 70, 100);

  ctx.font = '30px 微软雅黑';
  ctx.fillStyle = '#FF0000';
  ctx.fillText(priceDec, 110 + offset, 80);

  // 单位
  ctx.font = '16px 宋体';
  ctx.fillStyle = '#000000';
  ctx.fillText('元/' + textUnit, 120 + offset, 100);

  // 建议
  ctx.fillStyle = '#000000';
  drawFitText(ctx, textRemarks, 10, 120, 230, 16, 10, '宋体');

  convertDithering(canvas, 'bwr_none', 128);
}

/** 迷你价签模板 → 上传到设备 */
async function uploadMiniPriceTag() {
  const canvas = document.getElementById('text_data_canvas_1');
  if (!canvas) return;
  canvasRefresh();
  await uploadImageCanvas(canvas, 0, 1);
}

/* ============================================================
 * 商品标签模板
 * ------------------------------------------------------------
 * 布局（画布 250×122）：
 *   y=0-24    红色商品栏 + 白色产品名
 *   y=24-76   左侧主价格 / 右侧二维码
 *   y=76-122  左侧条形码 / 右侧产地与说明
 * ============================================================ */

let qrImageBitmap = null;
let barImageBitmap = null;

/** 二维码图片上传处理 */
function onQrCodeChange(fileInput) {
  if (!fileInput.files || fileInput.files.length === 0) return;
  loadImageBitmap(fileInput.files[0], (bmp) => {
    qrImageBitmap = bmp;
    addLog('✓ 二维码已加载: ' + fileInput.files[0].name + ' (' + bmp.width + '×' + bmp.height + ')');
    canvasRefreshGoods();
  });
}

/** 条形码图片上传处理 */
function onBarcodeChange(fileInput) {
  if (!fileInput.files || fileInput.files.length === 0) return;
  loadImageBitmap(fileInput.files[0], (bmp) => {
    barImageBitmap = bmp;
    addLog('✓ 条形码已加载: ' + fileInput.files[0].name + ' (' + bmp.width + '×' + bmp.height + ')');
    canvasRefreshGoods();
  });
}

function loadImageBitmap(file, onLoaded) {
  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      onLoaded(img);
    };
    img.onerror = function () {
      addLog('✗ 图片加载失败: ' + file.name);
    };
    img.src = e.target.result;
  };
  reader.onerror = function () {
    addLog('✗ 文件读取失败: ' + file.name);
  };
  reader.readAsDataURL(file);
}

/** 清除二维码/条形码 */
function clearGoodsExtras() {
  qrImageBitmap = null;
  barImageBitmap = null;
  const qr = document.getElementById('goods_qr');
  const bar = document.getElementById('goods_barcode');
  if (qr) qr.value = '';
  if (bar) bar.value = '';
  addLog('✓ 二维码/条形码已清除');
  canvasRefreshGoods();
}

/** 在画布上居中绘制一张图片到指定矩形（保持比例） */
function drawImageContain(ctx, img, x, y, w, h) {
  const ratio = Math.min(w / img.width, h / img.height);
  const dw = Math.floor(img.width * ratio);
  const dh = Math.floor(img.height * ratio);
  const dx = x + Math.floor((w - dw) / 2);
  const dy = y + Math.floor((h - dh) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** 商品标签模板实时渲染 */
function canvasRefreshGoods() {
  const canvas = document.getElementById('goods_canvas');
  if (!canvas) return;

  // 文字先在 4 倍分辨率上绘制，再高质量缩小到设备像素。
  // 这能保留更多圆弧轮廓，避免小字号直接栅格化产生明显锯齿。
  const renderScale = 4;
  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = canvas.width * renderScale;
  renderCanvas.height = canvas.height * renderScale;
  const ctx = renderCanvas.getContext('2d');
  ctx.scale(renderScale, renderScale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const productName = document.getElementById('goods_name').value || '';
  const priceInt = document.getElementById('goods_price_int').value || '0';
  const priceDec = document.getElementById('goods_price_dec').value || '0';
  const unit = document.getElementById('goods_unit').value || '';
  const origin = document.getElementById('goods_origin').value || '';
  const subTitle = document.getElementById('goods_subtitle').value || '';

  const uiFont = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif';
  const numberFont = '"Arial Rounded MT Bold", "Trebuchet MS", Arial, sans-serif';

  // 1. 红色商品栏：比旧版更高，让名称成为清晰的第一视觉层级
  ctx.fillStyle = '#FF0000';
  ctx.fillRect(0, 0, 250, 24);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawFitTextCenter(ctx, productName, 125, 12, 238, 17, 11, uiFont, '700 ');
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';

  // 2. 主信息区上边线
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 24.5);
  ctx.lineTo(250, 24.5);
  ctx.stroke();

  // 3. 大价格：整组自适应，既醒目又不会挤入二维码区域
  ctx.fillStyle = '#000000';
  const cleanInt = String(priceInt).trim() || '0';
  const cleanDec = String(priceDec).trim().replace(/^\./, '') || '0';
  const unitText = '元/' + unit;
  let priceSize = 43;
  let decSize = 36;
  const unitSize = 10;
  let intW = 0;
  let decW = 0;
  let unitW = 0;
  do {
    decSize = Math.max(25, Math.round(priceSize * 0.84));
    ctx.font = '800 ' + priceSize + 'px ' + numberFont;
    intW = ctx.measureText(cleanInt).width;
    ctx.font = '800 ' + decSize + 'px ' + numberFont;
    decW = ctx.measureText('.' + cleanDec).width;
    ctx.font = '700 ' + unitSize + 'px ' + uiFont;
    unitW = ctx.measureText(unitText).width;
    if (intW + decW + unitW + 8 <= 178) break;
    priceSize -= 2;
  } while (priceSize > 29);

  const priceX = 8;
  const priceBaseline = 69;
  ctx.font = '800 ' + priceSize + 'px ' + numberFont;
  ctx.fillText(cleanInt, priceX, priceBaseline);
  ctx.font = '800 ' + decSize + 'px ' + numberFont;
  ctx.fillText('.' + cleanDec, priceX + intW, priceBaseline);
  ctx.font = '700 ' + unitSize + 'px ' + uiFont;
  ctx.fillText(unitText, priceX + intW + decW + 5, priceBaseline - 1);

  // 4. 二维码：四周留白，避免紧贴价格和边框
  const qrX = 198, qrY = 29, qrW = 42, qrH = 42;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(qrX - 3, qrY - 3, qrW + 6, qrH + 6);
  if (!qrImageBitmap) {
    ctx.strokeStyle = '#B8B8B8';
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(qrX, qrY, qrW, qrH);
    ctx.setLineDash([]);
    ctx.fillStyle = '#777777';
    ctx.font = '9px ' + uiFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('二维码', qrX + qrW / 2, qrY + qrH / 2);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // 5. 底部分割线
  ctx.strokeStyle = '#000000';
  ctx.beginPath();
  ctx.moveTo(0, 76.5);
  ctx.lineTo(250, 76.5);
  ctx.stroke();

  // 6. 底部：条形码与说明分栏，沿用参考模板的留白比例
  const barX = 7, barY = 82, barW = 116, barH = 26;
  if (!barImageBitmap) {
    ctx.strokeStyle = '#B8B8B8';
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.setLineDash([]);
    ctx.fillStyle = '#777777';
    ctx.font = '9px ' + uiFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('请上传条形码', barX + barW / 2, barY + barH / 2);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // 条形码数字独立渲染，避免图片缩放后数字发虚
  const barcodeText = document.getElementById('goods_barcode_text').value || '';
  if (barcodeText) {
    ctx.fillStyle = '#000000';
    ctx.font = '8px ' + numberFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(barcodeText, barX + barW / 2, 116);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // 右侧说明：两行加粗，和参考图一样保持大字、短行、足够留白
  ctx.fillStyle = '#000000';
  drawFitText(ctx, origin, 135, 96, 108, 14, 10, uiFont, '700 ');
  drawFitText(ctx, subTitle, 135, 117, 108, 14, 10, uiFont, '700 ');

  // 将高分辨率文字缩到设备画布，保留更圆润、更均匀的笔画轮廓。
  const outputCtx = canvas.getContext('2d');
  outputCtx.clearRect(0, 0, canvas.width, canvas.height);
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = 'high';
  outputCtx.drawImage(renderCanvas, 0, 0, canvas.width, canvas.height);

  // 二维码和条形码最后按设备像素直接覆盖，避免高质量缩放使码点发糊。
  if (qrImageBitmap) {
    drawImageContain(outputCtx, qrImageBitmap, qrX, qrY, qrW, qrH);
  }
  if (barImageBitmap) {
    drawImageContain(outputCtx, barImageBitmap, barX, barY, barW, barH);
  }

  // 较低阈值可减少笔画外沿过度增粗，让圆角和字腔更自然。
  convertDithering(canvas, 'bwr_none', 160);
}

/** 商品标签 → 上传到设备 */
async function uploadGoodsTag() {
  const canvas = document.getElementById('goods_canvas');
  if (!canvas) return;
  canvasRefreshGoods();
  await uploadImageCanvas(canvas, 0, 1);
}

/**
 * 高清像素预览弹窗
 * 逻辑像素保持 250×122；显示时按 2× 放大，并根据 devicePixelRatio
 * 提升 backing store，避免 Windows 缩放和高分屏的二次插值造成文字模糊。
 */
function showGoodsActualSize() {
  const src = document.getElementById('goods_canvas');
  if (!src) return;
  // 先确保主预览是最新的
  canvasRefreshGoods();
  const dst = document.getElementById('goods_canvas_actual');
  if (!dst) return;
  const cssScale = window.matchMedia('(max-width: 600px)').matches ? 1 : 2;
  const cssWidth = 250 * cssScale;
  const cssHeight = 122 * cssScale;
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  dst.width = Math.round(cssWidth * dpr);
  dst.height = Math.round(cssHeight * dpr);
  dst.style.width = cssWidth + 'px';
  dst.style.height = cssHeight + 'px';
  const dCtx = dst.getContext('2d');
  dCtx.imageSmoothingEnabled = false;
  dCtx.clearRect(0, 0, dst.width, dst.height);
  dCtx.drawImage(src, 0, 0, dst.width, dst.height);
  document.getElementById('actualSizeModal').classList.add('active');
}

function closeGoodsActualSize(ev) {
  // 点遮罩或关闭按钮时关闭弹窗
  if (ev && ev.target && ev.target.id !== 'actualSizeModal' && !ev.target.classList.contains('modal-close')) {
    return;
  }
  document.getElementById('actualSizeModal').classList.remove('active');
}

/* ---------- 标签页切换 ---------- */
function showContent(contentId) {
  document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(contentId).classList.add('active');
  const idx = contentId.replace('content', '');
  const tabs = document.querySelectorAll('.tab');
  if (tabs[idx - 1]) tabs[idx - 1].classList.add('active');
}

/* ---------- 页面初始化 ---------- */
document.addEventListener('DOMContentLoaded', function () {
  showContent('content1');
});

window.addEventListener('load', function () {
  // 主画布初始化为白色
  const mainCanvas = document.getElementById('canvas');
  if (mainCanvas) {
    const ctx = mainCanvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);
  }
  // 迷你价签模板初始化
  canvasRefresh();
  // 商品标签模板初始化
  canvasRefreshGoods();
  // 系统就绪提示
  addLog('系统初始化完成');
  if (isDemoMode()) {
    addLog('提示: 当前环境不支持 Web Bluetooth，已自动启用演示模式。');
    addLog('      请使用 Chrome / Edge 浏览器打开，并连接 NRF 系列价签设备。');
  }
});

