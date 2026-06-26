// Exportación del control de fichadas a Excel (.xlsx) y PDF.
// Replica EXACTAMENTE lo que muestra la pantalla "Consulta de fichadas":
//   1) Resumen del período (mismos KPIs que las tarjetas de arriba)
//   2) Tabla por empleado (mismas columnas que la grilla)
//   3) Detalle día por día de cada empleado (mismo desglose que se abre al
//      hacer clic en una fila), con banco de horas, extras, tardanzas,
//      licencias del reloj y del portal, y novedades/inconsistencias.
//
// Fuente única: usa los mismos datos persistidos (fichadas_periodo.data) que
// la consulta, así el descargable y la página nunca divergen.
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import { minToHhmm } from './fichadasProsoft.js';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export function nombreMes(mes) {
  return MESES[(Number(mes) - 1 + 12) % 12] || String(mes);
}

// Etiqueta legible del estado de un día (espeja los badges de la página).
function estadoLabel(e) {
  switch (e) {
    case 'ok': return 'OK';
    case 'no-laborable': return 'Finde/feriado (a favor)';
    case 'revisar': return 'Revisar (marca incompleta)';
    case 'licencia': return 'Licencia';
    case 'licencia-portal': return 'Licencia (portal)';
    case 'injustificado': return 'INJUSTIFICADO';
    case 'home-office': return 'Home Office (trabajado)';
    default: return e || '';
  }
}

// Texto de la columna "Novedad / Licencia" (misma lógica que novedadDe() del front).
function novedadTexto(x) {
  if (x.licenciaConflicto) return `${x.licenciaPortal || 'Licencia'} aprobada — pero HAY MARCAS (no la tomó)`;
  if (x.comentario) return `${x.comentario}${x.sinLicenciaPortal ? ' · no está cargada en el portal' : ''}`;
  if (x.licenciaPortal) return `${x.licenciaPortal} (portal)${x.licenciaSoloPortal ? ' · no figura en el reloj' : ''}`;
  return '';
}

function extraTexto(x) {
  const e = (x.extra50Min || 0) + (x.extra100Min || 0);
  if (e <= 0) return '';
  return minToHhmm(e) + (x.extraComputa ? '' : ' (<30m)');
}

// Totales del período (espeja el objeto `tot` de la consulta).
export function totales(rows) {
  return rows.reduce((acc, r) => {
    const d = r.data || {};
    acc.empleados += 1;
    acc.dias += d.diasTrabajados || 0;
    acc.banco += d.bancoNetoMin || 0;
    acc.e50 += d.horasExtra50Min || 0;
    acc.e100 += d.horasExtra100Min || 0;
    acc.tarde += d.tardanzasMin || 0;
    acc.lic += d.diasLicencia || 0;
    acc.rev += (d.diasARevisar?.length || 0);
    acc.inj += d.diasInjustificados || 0;
    acc.conf += d.diasLicenciaConflicto || 0;
    return acc;
  }, { empleados: 0, dias: 0, banco: 0, e50: 0, e100: 0, tarde: 0, lic: 0, rev: 0, inj: 0, conf: 0 });
}

// ──────────────────────────────────────────────────────────────────────────
// EXCEL (.xlsx) — 3 hojas: Resumen, Por empleado, Detalle diario.
// ──────────────────────────────────────────────────────────────────────────
export function buildXlsx(periodo, rows) {
  const { anio, mes } = periodo;
  const t = totales(rows);
  const wb = XLSX.utils.book_new();

  // — Hoja 1: Resumen —
  const resumenAoa = [
    [`Control de fichadas — ${nombreMes(mes)} ${anio}`],
    [],
    ['Indicador', 'Valor'],
    ['Empleados', t.empleados],
    ['Días trabajados', t.dias],
    ['Banco (saldo total)', minToHhmm(t.banco)],
    ['Horas extra 50%', minToHhmm(t.e50)],
    ['Horas extra 100%', minToHhmm(t.e100)],
    ['Tardanzas', minToHhmm(t.tarde)],
    ['Días de licencia', t.lic],
    ['Días a revisar', t.rev],
    ['Días injustificados', t.inj],
    ['Conflictos de licencia', t.conf],
    [],
    [`Generado: ${new Date().toLocaleString('es-AR')}`],
  ];
  const wsResumen = XLSX.utils.aoa_to_sheet(resumenAoa);
  wsResumen['!cols'] = [{ wch: 26 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

  // — Hoja 2: Por empleado —
  const empHeader = ['Legajo', 'Empleado', 'Empresa', 'Días trab.', 'Banco mes', 'Hs Extra 50', 'Hs Extra 100', 'Tardanzas', 'Días tard.', 'Días lic.', 'A revisar', 'Injustif.', 'Conflic. lic.'];
  const empAoa = [empHeader];
  for (const r of rows) {
    const d = r.data || {};
    empAoa.push([
      r.leg_num,
      r.nom,
      r.empresa,
      d.diasTrabajados || 0,
      minToHhmm(d.bancoNetoMin || 0),
      minToHhmm(d.horasExtra50Min || 0),
      minToHhmm(d.horasExtra100Min || 0),
      minToHhmm(d.tardanzasMin || 0),
      d.diasTardanza || 0,
      d.diasLicencia || 0,
      d.diasARevisar?.length || 0,
      d.diasInjustificados || 0,
      d.diasLicenciaConflicto || 0,
    ]);
  }
  // Fila de totales
  empAoa.push(['', 'TOTAL', '', t.dias, minToHhmm(t.banco), minToHhmm(t.e50), minToHhmm(t.e100), minToHhmm(t.tarde), '', t.lic, t.rev, t.inj, t.conf]);
  const wsEmp = XLSX.utils.aoa_to_sheet(empAoa);
  wsEmp['!cols'] = [{ wch: 9 }, { wch: 30 }, { wch: 22 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 10 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
  wsEmp['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsEmp, 'Por empleado');

  // — Hoja 3: Detalle diario (una fila por empleado/día) —
  const detHeader = ['Legajo', 'Empleado', 'Fecha', 'Día', 'Entrada', 'Salida', 'Hs Netas', 'Jornada', 'Saldo día', 'Extra', 'Tarde', 'Estado', 'Novedad / Licencia'];
  const detAoa = [detHeader];
  for (const r of rows) {
    const dias = r.data?.dias || [];
    for (const x of dias) {
      detAoa.push([
        r.leg_num,
        r.nom,
        x.fecha,
        x.dia || '',
        x.entrada || '',
        x.salida || '',
        x.hsNetasMin > 0 ? minToHhmm(x.hsNetasMin) : '',
        minToHhmm(x.hsNormalMin || 0),
        x.saldoMin == null ? '' : minToHhmm(x.saldoMin),
        extraTexto(x),
        x.tardeMin > 0 ? minToHhmm(x.tardeMin) : '',
        estadoLabel(x.estado),
        novedadTexto(x),
      ]);
    }
  }
  const wsDet = XLSX.utils.aoa_to_sheet(detAoa);
  wsDet['!cols'] = [{ wch: 9 }, { wch: 30 }, { wch: 12 }, { wch: 6 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 26 }, { wch: 46 }];
  wsDet['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsDet, 'Detalle diario');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ──────────────────────────────────────────────────────────────────────────
// PDF — mismo contenido, formato para imprimir/archivar.
// ──────────────────────────────────────────────────────────────────────────
export function buildPdf(periodo, rows) {
  const { anio, mes } = periodo;
  const t = totales(rows);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const GREEN = '#16a34a', RED = '#dc2626', AMBER = '#d97706', BLUE = '#2563eb', MUT = '#666';

    // Encabezado
    doc.fontSize(16).fillColor('#111').text(`Control de fichadas — ${nombreMes(mes)} ${anio}`, left, doc.y);
    doc.moveDown(0.2);
    doc.fontSize(8).fillColor(MUT).text(`Generado: ${new Date().toLocaleString('es-AR')}`, left, doc.y);
    doc.moveDown(0.6);

    // Resumen (KPIs en línea)
    const kpis = [
      ['Empleados', String(t.empleados)],
      ['Días trab.', String(t.dias)],
      ['Banco total', minToHhmm(t.banco)],
      ['Hs extra 50', minToHhmm(t.e50)],
      ['Hs extra 100', minToHhmm(t.e100)],
      ['Tardanzas', minToHhmm(t.tarde)],
      ['Días licencia', String(t.lic)],
      ['A revisar', String(t.rev)],
      ['Injustif.', String(t.inj)],
      ['Conflic. lic.', String(t.conf)],
    ];
    const kpiW = pageW / kpis.length;
    let kx = left;
    const kpiTop = doc.y;
    for (const [lab, val] of kpis) {
      doc.fontSize(11).fillColor('#111').text(val, kx, kpiTop, { width: kpiW, align: 'left' });
      doc.fontSize(7).fillColor(MUT).text(lab, kx, kpiTop + 14, { width: kpiW, align: 'left' });
      kx += kpiW;
    }
    doc.y = kpiTop + 28;
    doc.x = left;
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    // ── Tabla por empleado ──
    doc.x = left;
    doc.fontSize(12).fillColor('#111').text('Resumen por empleado', left, doc.y);
    doc.moveDown(0.3);
    const empCols = [
      { k: 'leg', t: 'Leg.', w: 0.05, a: 'left' },
      { k: 'nom', t: 'Empleado', w: 0.22, a: 'left' },
      { k: 'emp', t: 'Empresa', w: 0.16, a: 'left' },
      { k: 'dias', t: 'Días', w: 0.06, a: 'right' },
      { k: 'banco', t: 'Banco', w: 0.09, a: 'right' },
      { k: 'e50', t: 'Extra 50', w: 0.09, a: 'right' },
      { k: 'tarde', t: 'Tard.', w: 0.08, a: 'right' },
      { k: 'lic', t: 'Lic.', w: 0.05, a: 'right' },
      { k: 'rev', t: 'Rev.', w: 0.05, a: 'right' },
      { k: 'inj', t: 'Injust.', w: 0.07, a: 'right' },
      { k: 'conf', t: 'Conf.', w: 0.06, a: 'right' },
    ];
    drawTable(doc, left, pageW, empCols, rows.map((r) => {
      const d = r.data || {};
      return {
        leg: r.leg_num, nom: r.nom, emp: r.empresa,
        dias: String(d.diasTrabajados || 0),
        banco: minToHhmm(d.bancoNetoMin || 0), _bancoNeg: (d.bancoNetoMin || 0) < 0,
        e50: minToHhmm(d.horasExtra50Min || 0),
        tarde: minToHhmm(d.tardanzasMin || 0),
        lic: String(d.diasLicencia || 0),
        rev: d.diasARevisar?.length ? String(d.diasARevisar.length) : '—', _revAmber: !!d.diasARevisar?.length,
        inj: d.diasInjustificados ? String(d.diasInjustificados) : '—', _injRed: !!d.diasInjustificados,
        conf: d.diasLicenciaConflicto ? String(d.diasLicenciaConflicto) : '—', _confRed: !!d.diasLicenciaConflicto,
      };
    }), {
      colorFor: (row, col) => {
        if (col.k === 'banco') return row._bancoNeg ? RED : GREEN;
        if (col.k === 'rev' && row._revAmber) return AMBER;
        if (col.k === 'inj' && row._injRed) return RED;
        if (col.k === 'conf' && row._confRed) return RED;
        return '#111';
      },
    });

    // ── Detalle diario por empleado ──
    const detCols = [
      { k: 'fecha', t: 'Fecha', w: 0.09, a: 'left' },
      { k: 'dia', t: 'Día', w: 0.06, a: 'left' },
      { k: 'entrada', t: 'Entrada', w: 0.07, a: 'left' },
      { k: 'salida', t: 'Salida', w: 0.07, a: 'left' },
      { k: 'netas', t: 'Hs Netas', w: 0.07, a: 'right' },
      { k: 'jornada', t: 'Jornada', w: 0.07, a: 'right' },
      { k: 'saldo', t: 'Saldo día', w: 0.07, a: 'right' },
      { k: 'extra', t: 'Extra', w: 0.09, a: 'right' },
      { k: 'tarde', t: 'Tarde', w: 0.06, a: 'right' },
      { k: 'estado', t: 'Estado', w: 0.15, a: 'left' },
      { k: 'nov', t: 'Novedad / Licencia', w: 0.13, a: 'left' },
    ];

    for (const r of rows) {
      const dias = r.data?.dias || [];
      if (!dias.length) continue;
      ensureSpace(doc, 60);
      doc.moveDown(0.6);
      doc.x = left;
      doc.fontSize(10).fillColor('#111').text(`${r.nom}  ·  Legajo ${r.leg_num}  ·  ${r.empresa}`, left, doc.y);
      doc.x = left;
      doc.fontSize(7.5).fillColor(MUT).text(`Banco del mes: ${minToHhmm(r.data?.bancoNetoMin || 0)} · Días trabajados: ${r.data?.diasTrabajados || 0}`, left, doc.y);
      doc.moveDown(0.2);
      drawTable(doc, left, pageW, detCols, dias.map((x) => ({
        fecha: x.fecha, dia: x.dia || '',
        entrada: x.entrada || '—', salida: x.salida || '—',
        netas: x.hsNetasMin > 0 ? minToHhmm(x.hsNetasMin) : '—',
        jornada: minToHhmm(x.hsNormalMin || 0),
        saldo: x.saldoMin == null ? '—' : minToHhmm(x.saldoMin), _saldo: x.saldoMin,
        extra: extraTexto(x) || '—',
        tarde: x.tardeMin > 0 ? minToHhmm(x.tardeMin) : '—', _tarde: x.tardeMin > 0 && x.completa,
        estado: estadoLabel(x.estado), _estado: x.estado,
        nov: novedadTexto(x) || '—', _conf: !!x.licenciaConflicto,
      })), {
        fontSize: 7.5,
        colorFor: (row, col) => {
          if (col.k === 'saldo') return row._saldo == null ? MUT : (row._saldo < 0 ? RED : GREEN);
          if (col.k === 'tarde' && row._tarde) return AMBER;
          if (col.k === 'estado') {
            if (row._estado === 'injustificado') return RED;
            if (row._estado === 'revisar') return AMBER;
            if (row._estado === 'ok' || row._estado === 'home-office') return GREEN;
            if (row._estado === 'licencia' || row._estado === 'licencia-portal') return BLUE;
            return MUT;
          }
          if (col.k === 'nov' && row._conf) return RED;
          return '#111';
        },
      });
    }

    doc.end();
  });
}

// Helper: salto de página si no entra `need` px de alto.
function ensureSpace(doc, need) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) doc.addPage();
}

// Helper: dibuja una tabla simple con encabezado, filas con zebra y paginado.
function drawTable(doc, left, pageW, cols, data, opts = {}) {
  const fontSize = opts.fontSize || 8;
  const padX = 3;
  const rowH = fontSize + 6;
  const colorFor = opts.colorFor || (() => '#111');
  const xOf = [];
  let acc = left;
  for (const c of cols) { xOf.push(acc); acc += c.w * pageW; }
  const wOf = cols.map((c) => c.w * pageW);

  const header = () => {
    const y = doc.y;
    doc.rect(left, y, pageW, rowH).fill('#f0f1f4');
    doc.fillColor('#333').fontSize(fontSize).font('Helvetica-Bold');
    cols.forEach((c, i) => doc.text(c.t, xOf[i] + padX, y + 3, { width: wOf[i] - padX * 2, align: c.a, lineBreak: false }));
    doc.font('Helvetica');
    doc.y = y + rowH;
  };

  header();
  data.forEach((row, idx) => {
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(left, y, pageW, rowH).fill('#fafafa');
    doc.fontSize(fontSize);
    cols.forEach((c, i) => {
      doc.fillColor(colorFor(row, c));
      doc.text(String(row[c.k] ?? ''), xOf[i] + padX, y + 3, { width: wOf[i] - padX * 2, align: c.a, lineBreak: false });
    });
    doc.y = y + rowH;
  });
  doc.fillColor('#111');
}
