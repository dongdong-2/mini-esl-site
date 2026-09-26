/* ============================================================
 * dithering.js — 图像抖动 / 二值化处理算法
 * 智能电子价签蓝牙控制中心
 * ------------------------------------------------------------
 * 支持算法：
 *   - none              二值化（阈值化）
 *   - bayer             4x4 Bayer 有序抖动
 *   - floydsteinberg    Floyd-Steinberg 误差扩散抖动
 *   - Atkinson          Atkinson 误差扩散抖动（推荐）
 *   - bwr_none          三色（黑/白/红）阈值化
 *   - bwr_floydsteinberg 三色 Floyd-Steinberg
 *   - bwr_Atkinson      三色 Atkinson
 * ============================================================ */

/* 三色调色板：黑 / 白 / 红 */
const bwrPalette = [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
  [255, 0, 0, 255]
];

/* 双色调色板：黑 / 白 */
const bwPalette = [
  [0, 0, 0, 255],
  [255, 255, 255, 255]
];

/* 4x4 Bayer 阈值矩阵 */
const BAYER_MAP = [
  [15, 135, 45, 165],
  [195, 75, 225, 105],
  [60, 180, 30, 150],
  [240, 120, 210, 90]
];

/* 预计算灰度亮度系数表，提升性能 */
const LUM_R = [], LUM_G = [], LUM_B = [];
for (let i = 0; i < 256; i++) {
  LUM_R[i] = i * 0.299;
  LUM_G[i] = i * 0.587;
  LUM_B[i] = i * 0.114;
}

/**
 * 黑白抖动处理（就地修改 canvas 像素）
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {number} threshold 二值化阈值 0-255
 * @param {string} type none | bayer | floydsteinberg | Atkinson
 */
function dithering(ctx, width, height, threshold, type) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const len = data.length;
  const w = imageData.width;

  // 转灰度（亮度 Y = 0.299R + 0.587G + 0.114B）
  for (let i = 0; i < len; i += 4) {
    data[i] = Math.floor(LUM_R[data[i]] + LUM_G[data[i + 1]] + LUM_B[data[i + 2]]);
  }

  for (let p = 0; p < len; p += 4) {
    const x = (p / 4) % w;
    const y = Math.floor(p / 4 / w);
    let newPixel, err;

    if (type === 'none') {
      // 纯阈值化
      data[p] = data[p] < threshold ? 0 : 255;
    } else if (type === 'bayer') {
      // 4x4 Bayer 有序抖动
      const map = Math.floor((data[p] + BAYER_MAP[x % 4][y % 4]) / 2);
      data[p] = map < threshold ? 0 : 255;
    } else if (type === 'floydsteinberg') {
      // Floyd–Steinberg 误差扩散
      newPixel = data[p] < 129 ? 0 : 255;
      err = Math.floor((data[p] - newPixel) / 16);
      data[p] = newPixel;
      data[p + 4] += err * 7;              // 右
      data[p + 4 * w - 4] += err * 3;      // 左下
      data[p + 4 * w] += err * 5;          // 下
      data[p + 4 * w + 4] += err * 1;      // 右下
    } else {
      // Bill Atkinson 误差扩散
      newPixel = data[p] < threshold ? 0 : 255;
      err = Math.floor((data[p] - newPixel) / 8);
      data[p] = newPixel;
      data[p + 4] += err;                  // 右
      data[p + 8] += err;                  // 右2
      data[p + 4 * w - 4] += err;          // 左下
      data[p + 4 * w] += err;              // 下
      data[p + 4 * w + 4] += err;          // 右下
      data[p + 8 * w] += err;              // 下2
    }

    // 同步 G/B 通道
    data[p + 1] = data[p + 2] = data[p];
  }

  ctx.putImageData(imageData, 0, 0);
}

/* ---------- 三色处理辅助函数 ---------- */

function getColorDistance(rgba1, rgba2) {
  const [r1, g1, b1] = rgba1;
  const [r2, g2, b2] = rgba2;
  const rm = (r1 + r2) / 2;
  const r = r1 - r2, g = g1 - g2, b = b1 - b2;
  return Math.sqrt((2 + rm / 256) * r * r + 4 * g * g + (2 + (255 - rm) / 256) * b * b);
}

/** 在调色板中寻找最近颜色（RGB 欧氏距离） */
function getNearColor(color, palette) {
  let minDist = 255 * 255 * 3 + 1;
  let best = palette[0];
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const rdiff = (color[0] & 0xff) - (c[0] & 0xff);
    const gdiff = (color[1] & 0xff) - (c[1] & 0xff);
    const bdiff = (color[2] & 0xff) - (c[2] & 0xff);
    const d = rdiff * rdiff + gdiff * gdiff + bdiff * bdiff;
    if (d < minDist) { minDist = d; best = c; }
  }
  return best;
}

function getColorErr(color1, color2, rate) {
  return [
    Math.floor((color1[0] - color2[0]) / rate),
    Math.floor((color1[1] - color2[1]) / rate),
    Math.floor((color1[2] - color2[2]) / rate)
  ];
}

function updatePixel(imageData, index, color) {
  imageData[index] = color[0];
  imageData[index + 1] = color[1];
  imageData[index + 2] = color[2];
  imageData[index + 3] = color[3];
}

function updatePixelErr(imageData, index, err, rate) {
  imageData[index] += err[0] * rate;
  imageData[index + 1] += err[1] * rate;
  imageData[index + 2] += err[2] * rate;
}

/**
 * 三色（黑白红）抖动处理（就地修改 canvas 像素）
 * @param {HTMLCanvasElement} canvas
 * @param {Array} palette 调色板
 * @param {string} type bwr_none | bwr_floydsteinberg | bwr_Atkinson
 * @param {number} threshold 阈值
 */
function ditheringCanvasByPalette(canvas, palette, type, threshold = 128) {
  palette = palette || bwrPalette;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const w = imageData.width;

  for (let p = 0; p <= data.length; p += 4) {
    if (type === 'bwr_floydsteinberg') {
      const newColor = getNearColor(data.slice(p, p + 4), palette);
      const err = getColorErr(data.slice(p, p + 4), newColor, 16);
      updatePixel(data, p, newColor);
      updatePixelErr(data, p + 4, err, 7);
      updatePixelErr(data, p + 4 * w - 4, err, 3);
      updatePixelErr(data, p + 4 * w, err, 5);
      updatePixelErr(data, p + 4 * w + 4, err, 1);
    } else if (type === 'bwr_none') {
      // 三色阈值（真实三色屏渲染）：
      //   明确红色像素（R 显著高于 G/B）→ 红
      //   其余像素按亮度灰度阈值 → 黑/白
      // 用亮度判定可避免文字/图片抗锯齿灰边被误判为红色晕边
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (r > 90 && (r - g) > 50 && (r - b) > 50) {
        data[p] = 255; data[p + 1] = 0; data[p + 2] = 0;
      } else {
        const gray = r * 0.299 + g * 0.587 + b * 0.114;
        if (gray >= threshold) {
          data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
        } else {
          data[p] = 0; data[p + 1] = 0; data[p + 2] = 0;
        }
      }
    } else {
      // 三色 Atkinson
      const newColor = getNearColor(data.slice(p, p + 4), palette);
      const err = getColorErr(data.slice(p, p + 4), newColor, 8);
      updatePixel(data, p, newColor);
      updatePixelErr(data, p + 4, err, 1);
      updatePixelErr(data, p + 8, err, 1);
      updatePixelErr(data, p + 4 * w - 4, err, 1);
      updatePixelErr(data, p + 4 * w, err, 1);
      updatePixelErr(data, p + 4 * w + 4, err, 1);
      updatePixelErr(data, p + 8 * w, err, 1);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * 根据选择的模式执行对应抖动处理
 * @param {HTMLCanvasElement} canvas
 * @param {string} mode 算法模式
 * @param {number} threshold 阈值
 */
function convertDithering(canvas, mode, threshold) {
  const ctx = canvas.getContext('2d');
  if (mode.startsWith('bwr')) {
    ditheringCanvasByPalette(canvas, bwrPalette, mode, parseInt(threshold));
  } else {
    dithering(ctx, canvas.width, canvas.height, parseInt(threshold), mode);
  }
}

/**
 * 将 canvas 像素打包为电子墨水屏位图字节数组
 * 扫描顺序：自左向右、自下而上，每 8 个像素合成 1 字节
 * @param {HTMLCanvasElement} canvas
 * @param {number} t_width 目标宽度
 * @param {number} t_height 目标高度
 * @param {string} type 'bw' 黑白 | 'bwr' 三色（仅取红色像素为1）
 * @param {number} scale 采样步长
 * @returns {Array<number>} 位图字节数组
 */
function canvas2bytes(canvas, t_width, t_height, type = 'bw', scale = 1) {
  const ctx = canvas.getContext('2d');
  const x_step = scale;
  const y_step = scale;
  const imageData = ctx.getImageData(0, 0, t_width * x_step, t_height * y_step);
  const data = imageData.data;

  const arr = [];
  let buffer = [];
  const width = t_width * x_step;
  const height = Math.floor((t_height + 7) / 8) * 8 * y_step;
  const scale_offset = Math.floor(scale / 2);

  for (let x = 0; x <= width - x_step; x += x_step) {
    for (let y = t_height - y_step; y >= t_height - height; y -= y_step) {
      const index = (width * 4 * (y + scale_offset)) + (x + scale_offset) * 4;
      if (type !== 'bwr') {
        // 黑白：非黑即白（R 通道 > 0 → 1）
        buffer.push(data[index] > 0 ? 1 : 0);
      } else {
        // 三色：红色像素 → 1（R>0 且 G=0 且 B=0）
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

