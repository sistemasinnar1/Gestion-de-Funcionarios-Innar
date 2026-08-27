const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const storage = require('./storage');

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

async function appendFileToPdf(pdfDoc, absPath, nombre) {
  const bytes = fs.readFileSync(absPath);
  const ext = extOf(nombre || absPath);
  if (ext === '.pdf') {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await pdfDoc.copyPages(src, src.getPageIndices());
    pages.forEach((p) => pdfDoc.addPage(p));
    return;
  }
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const img = ext === '.png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return;
  }
  throw new Error(`Formato no soportado para empaquetar: ${nombre}`);
}

/**
 * @param {Array<{ path: string, nombre: string }>} items
 * @returns {Promise<Uint8Array>}
 */
async function empaquetarPdf(items) {
  const pdfDoc = await PDFDocument.create();
  let added = 0;
  for (const item of items) {
    const abs = storage.resolverLectura(item.path) || (fs.existsSync(item.path) ? item.path : '');
    if (!abs) continue;
    try {
      await appendFileToPdf(pdfDoc, abs, item.nombre || abs);
      added += 1;
    } catch (_) {
      /* salta archivos corruptos o no compatibles */
    }
  }
  if (!added) {
    const page = pdfDoc.addPage([595, 842]);
    page.drawText('No se pudo incluir ningún archivo seleccionado.', {
      x: 50,
      y: 780,
      size: 12
    });
  }
  return pdfDoc.save();
}

module.exports = { empaquetarPdf };
