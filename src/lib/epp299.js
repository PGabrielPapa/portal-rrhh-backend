// Formulario reglamentario "ENTREGA DE ROPA DE TRABAJO Y ELEMENTOS DE PROTECCIÓN
// PERSONAL" — Resolución SRT 299/11, Anexo I. Se genera ya completo con los datos
// que el sistema tiene del empleado, la empresa y la entrega de EPP, para no
// cargarlo ni subirlo a mano. Diseño idéntico al modelo oficial: título, datos de
// la empresa y el trabajador, tabla de 7 columnas por 18 renglones, e información
// adicional.
import PDFDocument from 'pdfkit';

const fmtFecha = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

// Genera el PDF y lo devuelve como Buffer.
// data: { razonSocial, cuit, direccion, localidad, cp, provincia, trabajador, dni,
//         puesto, elementosTexto, filas:[{producto, tipoModelo, marca, certifica, cantidad, fecha}], infoAdicional }
export function generarFormulario299(data = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const W = R - L;
    const box = (x, y, w, h) => doc.rect(x, y, w, h).lineWidth(0.7).strokeColor('#000').stroke();
    const lbl = (t, x, y, w) => doc.font('Helvetica').fontSize(6).fillColor('#000').text(t, x + 2, y + 1.5, { width: w - 4, lineBreak: false });
    const val = (t, x, y, w, size = 8) => doc.font('Helvetica-Bold').fontSize(size).fillColor('#000').text(String(t ?? ''), x + 2, y + 8, { width: w - 4, lineBreak: false });

    let y = doc.page.margins.top;

    // Referencia a la resolución (arriba a la derecha).
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#000').text('Resolución 299/11, Anexo I', R - 160, y - 2, { width: 160, align: 'right' });
    y += 10;

    // Título.
    const tituloH = 16;
    box(L, y, W, tituloH);
    doc.font('Helvetica-Bold').fontSize(9).text('ENTREGA DE ROPA DE TRABAJO Y ELEMENTOS DE PROTECCIÓN PERSONAL', L, y + 4, { width: W, align: 'center' });
    y += tituloH;

    // Fila 1: Razón Social | CUIT
    const f1 = 20; const wC = 150;
    box(L, y, W - wC, f1); lbl('Razón Social:', L, y, W - wC); val(data.razonSocial, L + 58, y, W - wC - 58);
    box(R - wC, y, wC, f1); lbl('C.U.I.T.:', R - wC, y, wC); val(data.cuit, R - wC + 40, y, wC - 40);
    y += f1;

    // Fila 2: Dirección | Localidad | C.P. | Provincia
    const f2 = 20; const w2 = W / 4;
    box(L, y, w2, f2); lbl('Dirección:', L, y, w2); val(data.direccion, L + 46, y, w2 - 46);
    box(L + w2, y, w2, f2); lbl('Localidad:', L + w2, y, w2); val(data.localidad, L + w2 + 44, y, w2 - 44);
    box(L + 2 * w2, y, w2, f2); lbl('C.P.:', L + 2 * w2, y, w2); val(data.cp, L + 2 * w2 + 24, y, w2 - 24);
    box(L + 3 * w2, y, W - 3 * w2, f2); lbl('Provincia:', L + 3 * w2, y, w2); val(data.provincia, L + 3 * w2 + 42, y, w2 - 42);
    y += f2;

    // Fila 3: Nombre y Apellido del Trabajador | D.N.I.
    const f3 = 20; const wD = 150;
    box(L, y, W - wD, f3); lbl('Nombre y Apellido del Trabajador:', L, y, W - wD); val(data.trabajador, L + 150, y, W - wD - 150);
    box(R - wD, y, wD, f3); lbl('D.N.I.:', R - wD, y, wD); val(data.dni, R - wD + 36, y, wD - 36);
    y += f3;

    // Fila 4: dos cajas grandes (descripción del puesto | elementos necesarios)
    const f4 = 42; const half = W / 2;
    box(L, y, half, f4); lbl('Descripción breve del puesto de trabajo en el/los cuales se desempeña el trabajador:', L, y, half);
    doc.font('Helvetica').fontSize(8).text(String(data.puesto || ''), L + 3, y + 12, { width: half - 6 });
    box(L + half, y, W - half, f4); lbl('Elementos de protección personal, necesarios para el trabajador, según el puesto de trabajo:', L + half, y, W - half);
    doc.font('Helvetica').fontSize(8).text(String(data.elementosTexto || ''), L + half + 3, y + 12, { width: W - half - 6 });
    y += f4;

    // Tabla: índice + 7 columnas.
    const cols = [
      { t: '', w: 18, k: 'idx', a: 'center' },
      { t: 'Producto', w: 120, k: 'producto', a: 'left' },
      { t: 'Tipo / Modelo', w: 110, k: 'tipoModelo', a: 'left' },
      { t: 'Marca', w: 95, k: 'marca', a: 'left' },
      { t: 'Posee certificación SI / NO', w: 95, k: 'certifica', a: 'center' },
      { t: 'Cantidad', w: 55, k: 'cantidad', a: 'center' },
      { t: 'Fecha de entrega', w: 80, k: 'fecha', a: 'center' },
      { t: 'Firma del trabajador', w: 0, k: 'firma', a: 'left' },
    ];
    const fixed = cols.reduce((s, c) => s + c.w, 0);
    cols[cols.length - 1].w = W - fixed;        // la última ocupa lo que resta
    const xOf = []; let acc = L; for (const c of cols) { xOf.push(acc); acc += c.w; }

    // Encabezado de tabla.
    const headH = 24;
    doc.save();
    cols.forEach((c, i) => { box(xOf[i], y, c.w, headH); doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text(c.t, xOf[i] + 2, y + 5, { width: c.w - 4, align: 'center' }); });
    doc.restore();
    y += headH;

    // 18 renglones.
    const rowH = 18;
    for (let n = 1; n <= 18; n++) {
      const row = (data.filas && data.filas[n - 1]) || {};
      cols.forEach((c, i) => {
        box(xOf[i], y, c.w, rowH);
        let txt = '';
        if (c.k === 'idx') txt = String(n);
        else if (c.k === 'fecha') txt = row.fecha ? fmtFecha(row.fecha) : '';
        else txt = row[c.k] != null ? String(row[c.k]) : '';
        if (txt) doc.font('Helvetica').fontSize(7.5).fillColor('#000').text(txt, xOf[i] + 2, y + 5, { width: c.w - 4, align: c.a, lineBreak: false });
      });
      y += rowH;
    }

    // Información adicional.
    const infoH = 34;
    box(L, y, W, infoH); lbl('Información adicional:', L, y, W);
    if (data.infoAdicional) doc.font('Helvetica').fontSize(8).text(String(data.infoAdicional), L + 3, y + 12, { width: W - 6 });

    doc.end();
  });
}

export default generarFormulario299;
