/* ===========================================================================
   PP-OCR (PaddleOCR v4 mobile) — fully offline browser OCR engine.

   Replaces the previous Tesseract.js pipeline. Everything runs locally:
     libs/onnx/ort.wasm.min.js          onnxruntime-web (WASM, single thread)
     models/ppocr/det.onnx              PP-OCRv4 mobile text detector (DB)
     models/ppocr/rec.onnx              en_PP-OCRv4 mobile text recogniser (CTC)
     models/ppocr/en_dict.json          recogniser character dictionary

   No CDN, no cloud service, no runtime model download.

   Public API (window.PPOCR):
     PPOCR.available()            -> boolean
     await PPOCR.init()           -> loads the two ONNX sessions (cached)
     await PPOCR.recognize(cvs)   -> Tesseract-compatible shape:
        { data: { text, confidence, words:[{text,confidence}],
                  lines:[{text,confidence,box}] } }
   =========================================================================== */
(function (global) {
  'use strict';

  /* Absolute local URLs derived from this script's own location, so the
     engine works from any sub-path (and inside the installed PWA). */
  var _SELF = (document.currentScript && document.currentScript.src) ||
              new URL('./libs/ppocr/ppocr.js', location.href).href;
  var APP_ROOT = new URL('../../', _SELF).href;
  var ORT_DIR = APP_ROOT + 'libs/onnx/';
  var MODEL_DIR = APP_ROOT + 'models/ppocr/';

  var _ort = null;
  var _det = null;
  var _rec = null;
  var _dict = null;
  var _initPromise = null;

  var DET_LIMIT = 1600;     // max side fed to the detector (small crops are upscaled)
  var DET_THRESH = 0.3;     // probability map binarisation
  var BOX_THRESH = 0.5;     // mean probability required to keep a box
  var UNCLIP = 1.7;         // DB box expansion
  var REC_H = 48;
  var REC_MAX_W = 1200;   // wide ID lines keep their aspect ratio (no squashing)

  function available() {
    return typeof global.ort !== 'undefined';
  }

  async function init() {
    if (_det && _rec) return true;
    if (_initPromise) return _initPromise;
    _initPromise = (async function () {
      if (!available()) throw new Error('Local OCR runtime (onnxruntime-web) not available');
      _ort = global.ort;
      _ort.env.wasm.wasmPaths = ORT_DIR;
      _ort.env.wasm.numThreads = 1;          // no COOP/COEP needed offline
      _ort.env.wasm.proxy = false;
      _ort.env.logLevel = 'error';
      var opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      var dictResp = await fetch(MODEL_DIR + 'en_dict.json');
      var chars = await dictResp.json();
      _dict = [''].concat(chars).concat([' ']);
      var pair = await Promise.all([
        _ort.InferenceSession.create(MODEL_DIR + 'det.onnx', opts),
        _ort.InferenceSession.create(MODEL_DIR + 'rec.onnx', opts)
      ]);
      _det = pair[0];
      _rec = pair[1];
      return true;
    })();
    try { return await _initPromise; }
    catch (e) { _initPromise = null; throw e; }
  }

  function dispose() {
    try { if (_det && _det.release) _det.release(); } catch (e) {}
    try { if (_rec && _rec.release) _rec.release(); } catch (e) {}
    _det = null; _rec = null; _initPromise = null;
  }

  /* ---------------------------- detection ---------------------------- */

  function _detInput(src) {
    var w = src.width, h = src.height;
    // Small camera crops are upscaled (up to 2x) so faint ID text survives
    // detection; large images are still capped at DET_LIMIT.
    var ratio = Math.min(2, DET_LIMIT / Math.max(w, h));
    var tw = Math.max(32, Math.round(w * ratio / 32) * 32);
    var th = Math.max(32, Math.round(h * ratio / 32) * 32);
    var c = document.createElement('canvas');
    c.width = tw; c.height = th;
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, tw, th);
    var d = ctx.getImageData(0, 0, tw, th).data;
    var f = new Float32Array(3 * tw * th);
    var mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    var plane = tw * th;
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      f[p] = (d[i] / 255 - mean[0]) / std[0];
      f[plane + p] = (d[i + 1] / 255 - mean[1]) / std[1];
      f[2 * plane + p] = (d[i + 2] / 255 - mean[2]) / std[2];
    }
    return { data: f, w: tw, h: th, sx: w / tw, sy: h / th };
  }

  /* Connected components over the binarised probability map. */
  function _boxesFromMap(prob, w, h, sx, sy, ow, oh) {
    var bin = new Uint8Array(w * h);
    var i;
    for (i = 0; i < prob.length; i++) bin[i] = prob[i] > DET_THRESH ? 1 : 0;
    var seen = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var boxes = [];
    for (var start = 0; start < bin.length; start++) {
      if (!bin[start] || seen[start]) continue;
      var sp = 0;
      stack[sp++] = start; seen[start] = 1;
      var minx = w, maxx = -1, miny = h, maxy = -1, sum = 0, count = 0;
      while (sp > 0) {
        var idx = stack[--sp];
        var y = (idx / w) | 0, x = idx - y * w;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        sum += prob[idx]; count++;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            var nidx = ny * w + nx;
            if (bin[nidx] && !seen[nidx]) { seen[nidx] = 1; stack[sp++] = nidx; }
          }
        }
      }
      if (count < 8) continue;
      var score = sum / count;
      if (score < BOX_THRESH) continue;
      var bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw < 3 || bh < 3) continue;
      // DB unclip: expand the box outwards by area*ratio/perimeter
      var d = (bw * bh * UNCLIP) / (2 * (bw + bh));
      var x0 = Math.max(0, Math.round((minx - d) * sx));
      var y0 = Math.max(0, Math.round((miny - d) * sy));
      var x1 = Math.min(ow, Math.round((maxx + 1 + d) * sx));
      var y1 = Math.min(oh, Math.round((maxy + 1 + d) * sy));
      if (x1 - x0 < 5 || y1 - y0 < 5) continue;
      boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: score });
    }
    return boxes;
  }

  async function _detect(src) {
    var inp = _detInput(src);
    var tensor = new _ort.Tensor('float32', inp.data, [1, 3, inp.h, inp.w]);
    var feeds = {}; feeds[_det.inputNames[0]] = tensor;
    var out = await _det.run(feeds);
    var o = out[_det.outputNames[0]];
    var dims = o.dims;                       // [1,1,H,W]
    var mh = dims[2], mw = dims[3];
    var boxes = _boxesFromMap(o.data, mw, mh, inp.w / mw * inp.sx, inp.h / mh * inp.sy,
      src.width, src.height);
    return boxes;
  }

  /* --------------------------- recognition --------------------------- */

  function _cropCanvas(src, box) {
    var pad = Math.max(1, Math.round(box.h * 0.06));
    var x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    var w = Math.min(src.width - x, box.w + pad * 2);
    var h = Math.min(src.height - y, box.h + pad * 2);
    var tw = Math.min(REC_MAX_W, Math.max(16, Math.round(REC_H * w / h)));
    var c = document.createElement('canvas');
    c.width = tw; c.height = REC_H;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, w, h, 0, 0, tw, REC_H);
    return c;
  }

  async function _recognizeCrop(crop) {
    var ctx = crop.getContext('2d');
    var d = ctx.getImageData(0, 0, crop.width, crop.height).data;
    var w = crop.width, h = crop.height, plane = w * h;
    var f = new Float32Array(3 * plane);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      f[p] = (d[i] / 255 - 0.5) / 0.5;
      f[plane + p] = (d[i + 1] / 255 - 0.5) / 0.5;
      f[2 * plane + p] = (d[i + 2] / 255 - 0.5) / 0.5;
    }
    var tensor = new _ort.Tensor('float32', f, [1, 3, h, w]);
    var feeds = {}; feeds[_rec.inputNames[0]] = tensor;
    var out = await _rec.run(feeds);
    var o = out[_rec.outputNames[0]];
    var T = o.dims[1], C = o.dims[2], data = o.data;
    var text = '', confSum = 0, confN = 0, prev = -1;
    for (var t = 0; t < T; t++) {
      var best = 0, bestV = -Infinity, base = t * C;
      for (var c = 0; c < C; c++) {
        var v = data[base + c];
        if (v > bestV) { bestV = v; best = c; }
      }
      if (best !== 0 && best !== prev) {
        text += _dict[best] || '';
        confSum += bestV; confN++;
      }
      prev = best;
    }
    return { text: text.trim(), confidence: confN ? Math.max(0, Math.min(1, confSum / confN)) * 100 : 0 };
  }

  /* Groups detected boxes into visual rows (left to right, top to bottom) so
     "LAST NAME" and its value on the same row become one text line. */
  function _layoutLines(items) {
    var sorted = items.slice().sort(function (a, b) { return a.box.y - b.box.y; });
    var rows = [];
    sorted.forEach(function (it) {
      var cy = it.box.y + it.box.h / 2;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var overlap = Math.min(r.y1, it.box.y + it.box.h) - Math.max(r.y0, it.box.y);
        var minH = Math.min(r.y1 - r.y0, it.box.h);
        var rcy = (r.y0 + r.y1) / 2;
        // Both centres must fall inside the other band: keeps neighbouring
        // rows of a dense ID layout from being merged into one line.
        var sameRow = overlap > minH * 0.62 &&
                      cy >= r.y0 && cy <= r.y1 &&
                      rcy >= it.box.y && rcy <= it.box.y + it.box.h;
        if (sameRow) {
          r.items.push(it);
          r.y0 = Math.min(r.y0, it.box.y);
          r.y1 = Math.max(r.y1, it.box.y + it.box.h);
          return;
        }
      }
      rows.push({ y0: it.box.y, y1: it.box.y + it.box.h, items: [it] });
    });
    rows.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    return rows.map(function (r) {
      r.items.sort(function (a, b) { return a.box.x - b.box.x; });
      var conf = r.items.reduce(function (s, i) { return s + i.confidence; }, 0) / r.items.length;
      return {
        text: r.items.map(function (i) { return i.text; }).join(' ').replace(/\s+/g, ' ').trim(),
        confidence: conf,
        box: { x: r.items[0].box.x, y: r.y0, w: 0, h: r.y1 - r.y0 },
        items: r.items
      };
    }).filter(function (l) { return l.text; });
  }

  async function recognize(source) {
    await init();
    var boxes = await _detect(source);
    // cap the work on very noisy frames; keep the biggest/strongest regions
    if (boxes.length > 140) {
      // Keep the strongest text regions, never the biggest: a busy background
      // behind the ID produces large blobs that would evict real ID text.
      boxes.sort(function (a, b) { return b.score - a.score; });
      boxes = boxes.slice(0, 140);
    }
    var items = [];
    for (var i = 0; i < boxes.length; i++) {
      var crop = _cropCanvas(source, boxes[i]);
      var r;
      try { r = await _recognizeCrop(crop); }
      catch (e) { r = null; }
      try { crop.width = 1; crop.height = 1; } catch (e) {}
      if (!r || !r.text) continue;
      items.push({ text: r.text, confidence: r.confidence, box: boxes[i] });
    }
    var lines = _layoutLines(items);
    var text = lines.map(function (l) { return l.text; }).join('\n');
    var confidence = items.length
      ? items.reduce(function (s, i) { return s + i.confidence; }, 0) / items.length
      : 0;
    return {
      data: {
        text: text,
        confidence: confidence,
        words: items.map(function (i) { return { text: i.text, confidence: i.confidence }; }),
        lines: lines.map(function (l) { return { text: l.text, confidence: l.confidence, box: l.box }; })
      }
    };
  }

  global.PPOCR = {
    available: available,
    init: init,
    dispose: dispose,
    recognize: recognize,
    engineName: 'PP-OCRv4 (PaddleOCR) / onnxruntime-web'
  };
})(window);
