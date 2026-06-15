function getValidador(emp) {
  const nom = emp.nom.toUpperCase().trim();
  const lugar = (emp.lugar || "").toUpperCase();
  if (emp.validador && emp.validador.trim()) {
    return {
      validador: emp.validador.toUpperCase().trim(),
      area: (emp.areaOrg || emp.area || "General").trim(),
      goToHR: emp.validadorGoToHR !== void 0 ? emp.validadorGoToHR : true,
      autoApproved: !!emp.validadorAutoApproved,
      _override: true
    };
  }
  if (nom.includes("PARERA, MARTIN"))
    return { validador: "PARERA, MARTIN", area: "CEO \u2014 LEITEN \xB7 LEITEN SALTA \xB7 IDEE \xB7 SINIS \xB7 BARTON REBAR", goToHR: true, autoApproved: true };
  if (nom.includes("PAPA, PABLO GABRIEL"))
    return { validador: "PARERA, MARTIN", area: "Legales y RR.HH.", goToHR: true, autoApproved: true };
  if (nom.includes("GARRIDO, JUAN MANUEL"))
    return { validador: "PARERA, MARTIN", area: "Gerencia Comercial General", goToHR: true };
  if (nom.includes("PARERA, PABLO ANDRES"))
    return { validador: "PARERA, MARTIN", area: "Operaciones / Servicio T\xE9cnico", goToHR: true };
  if (nom.includes("KEOGAN"))
    return { validador: "PARERA, MARTIN", area: "Desarrollo / Barton Rebar", goToHR: true };
  if (nom.includes("YAKUS"))
    return { validador: "PARERA, MARTIN", area: "Producto y Marketing", goToHR: true };
  if (nom.includes("BOTTAZZI"))
    return { validador: "PARERA, MARTIN", area: "Administraci\xF3n LEITEN", goToHR: true };
  if (nom.includes("FERNANDEZ, RODOLFO"))
    return { validador: "PARERA, MARTIN", area: "Administraci\xF3n SINIS", goToHR: true };
  if (nom.includes("RODRIGUEZ, ADRIAN"))
    return { validador: "PARERA, MARTIN", area: "Gerencia Zonal LEITEN SALTA", goToHR: true };
  if (nom.includes("GUILLEN"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Comercial LEITEN \u2014 Gerencia Buenos Aires", goToHR: false };
  if (nom.includes("CARRERA"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Comercial SINIS", goToHR: false };
  if (nom.includes("BASSO"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Gerencia Regional (C\xF3rdoba/Neuqu\xE9n/Mendoza)", goToHR: false };
  if (nom.includes("NICOLOSI"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Gerencia Regional (Santa Fe/Corrientes/Rosario/Salta)", goToHR: false };
  if (emp.cat === "GER")
    return { validador: "RR.HH.", area: "Gerencia", goToHR: true };
  {
    const empCo = (emp.emp || "").toUpperCase();
    if (empCo.includes("LEITEN SALTA") || lugar.includes("SUCURSAL SALTA"))
      return { validador: "RODRIGUEZ, ADRIAN ROBERTO", area: "LEITEN SALTA", goToHR: false };
  }
  const legalesRRHH = [
    "BOZZUTO",
    "AGUIAR, LUNA",
    "DONATO",
    "PAPA, LUCIANO",
    "GONZALEZ, WALTER",
    "OLIVERA, WALTER",
    "BIZZOTTO"
  ];
  if (legalesRRHH.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "PAPA, PABLO GABRIEL", area: "Legales y RR.HH.", goToHR: true };
  if (nom.includes("HEINZE"))
    return { validador: "PARERA, MARTIN", area: "COMEX", goToHR: true };
  const comercialLeiten = [
    "BERTOSSI",
    "TORRES MAGNE",
    "QUINTANA, WALTER",
    "DIAZ, JENNIFER",
    "TORTELLI"
  ];
  if (comercialLeiten.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "GUILLEN, HERNAN NICOLAS", area: "Comercial LEITEN \u2014 Gerencia Buenos Aires", goToHR: false };
  const comercialSinis = [
    "PUJOL",
    "GALVAN , MARCOS",
    "VILLANUEVA SILVEIRA",
    "SOTELO",
    "ALBINES GUEVARA",
    "GERVASIO"
  ];
  if (comercialSinis.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "CARRERA, IVO GABRIEL", area: "Comercial SINIS", goToHR: false };
  if (nom.includes("GUILLEN"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Comercial LEITEN", goToHR: false };
  if (nom.includes("CARRERA"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Comercial SINIS", goToHR: false };
  const adminLeiten = [
    "VATRANO",
    "FIUZA",
    "GIMENEZ, MARINA",
    "ZEBALLOS",
    "ALONSO",
    "DARRUSPE",
    "LONGO, MORENA"
  ];
  if (adminLeiten.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "BOTTAZZI, ROBERTO OMAR", area: "Administraci\xF3n LEITEN", goToHR: false };
  const adminSinis = [
    "NICODEMO",
    "VITKAUSKAS",
    "LEIMETER",
    "MARTINEZ, LOURDES",
    "FERNANDEZ CALVO",
    "GALLARDO, NORA",
    "JEREZ"
  ];
  if (adminSinis.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "FERNANDEZ, RODOLFO EMILIO", area: "Administraci\xF3n SINIS", goToHR: false };
  const productoMkt = ["DIEGUEZ", "MOYANO , LUCIANO", "GARCIA AROS"];
  if (productoMkt.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "YAKUS, MARCELO ROBERTO", area: "Producto y Marketing", goToHR: false };
  const servTecnico = [
    "OLIVERA, MATIAS",
    "YDOY",
    "MUSLADINI",
    "PINOTTI",
    "AGUIAR , AGUSTIN",
    "PEREZ, CIRO",
    "VELIZ",
    "OLIVERA, GUSTAVO",
    "VARELA , AXEL",
    "FERREIRA , VALENTINO",
    "ABIBE"
  ];
  if (servTecnico.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "PARERA, PABLO ANDRES", area: "Servicio T\xE9cnico", goToHR: false };
  if (nom.includes("MORINI"))
    return { validador: "PARERA, PABLO ANDRES", area: "Servicio T\xE9cnico", goToHR: false };
  if (nom.includes("RAPAPORT") || nom.includes("POLETTO"))
    return { validador: "PARERA, PABLO ANDRES", area: "Programaci\xF3n", goToHR: false };
  const operaciones = [
    "DI FLORIO",
    "DIAZ OLIVIERI",
    "MIRANDA",
    "HERRERA, YESICA",
    "RODRIGUEZ FERREYRA",
    "CORDERO ROA",
    "PEREYRA",
    "PAEZ, FACUNDO",
    "CESARIO",
    "AGUIAR, YANINA",
    "RAMOS GENEROSO",
    "MENDIETA",
    "BARREDA",
    "MEZA, ALBERTO",
    "RODRIGUEZ, GUSTAVO",
    "MARTINEZ , JUAN",
    "DE LA ROSA",
    "PAEZ, FRANCO",
    "GENTILE",
    "QUIROZ",
    "FARI\xD1A",
    "OSORES",
    "SPRING"
  ];
  if (operaciones.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "PARERA, PABLO ANDRES", area: "Operaciones", goToHR: false };
  const desarrollo = ["LOSTES", "GIGENA", "ZABALA CRUZ", "FROLA"];
  if (desarrollo.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "KEOGAN, PATRICIO MATIAS", area: "Desarrollo", goToHR: false };
  const barton = ["MEZA ALINCASTRO", "NU\xD1EZ, DANTE", "PALOMEQUE", "RODRIGUEZ, FERNANDO", "TORMAKH", "ARCE"];
  if (barton.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "KEOGAN, PATRICIO MATIAS", area: "Barton Rebar", goToHR: false };
  const regionBasso = [
    "YA\xD1EZ",
    "MORALES",
    "LOBOS",
    "ARGUELLO",
    "ALVAREZ, LUCIANA",
    "SOSA BASTIAS",
    "SCHMIDT",
    "ARANEGA",
    "CARMONA SALINAS",
    "JALIL",
    "AZARIO",
    "BUSTOS"
  ];
  if (regionBasso.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "BASSO, ARIEL MARIANO", area: "Gerencia Regional (C\xF3rdoba/Neuqu\xE9n/Mendoza)", goToHR: false };
  const regionNicolosi = [
    "ABADIA",
    "RUATTA",
    "CORIA",
    "GUANCA",
    "GOMEZ, GUSTAVO",
    "FERNANDEZ, OSVALDO",
    "SOSA , FABIAN",
    "PARRA",
    "GALLARDO, GONZALO",
    "AQUINO",
    "SOTOMAYOR",
    "GAGLIARDI",
    "FARIAS , MARTIN",
    "SANCHEZ, ANDRES",
    "AYALA",
    "GONZALEZ , DEBORA",
    "CHANAMPA",
    "SANCHEZ, ALICIA",
    "SBROCCO",
    "OLIVER OBED",
    "RONDOLETTO",
    "MALGIOGLIO"
  ];
  if (regionNicolosi.some((s) => nom.includes(s.toUpperCase())))
    return { validador: "NICOLOSI, ADRIAN PABLO", area: "Gerencia Regional (Santa Fe/Corrientes/Rosario/Salta)", goToHR: false };
  if (nom.includes("BASSO"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Gerencia Regional (C\xF3rdoba/Neuqu\xE9n/Mendoza)", goToHR: false };
  if (nom.includes("NICOLOSI"))
    return { validador: "GARRIDO, JUAN MANUEL", area: "Gerencia Regional (Santa Fe/Corrientes/Rosario/Salta)", goToHR: false };
  if (["CORDOBA", "NEUQUEN", "MENDOZA"].some((l) => lugar.includes(l)))
    return { validador: "BASSO, ARIEL MARIANO", area: "Gerencia Regional", goToHR: false };
  if (["SANTA FE", "CORRIENTES", "ROSARIO"].some((l) => lugar.includes(l)))
    return { validador: "NICOLOSI, ADRIAN PABLO", area: "Gerencia Regional", goToHR: false };
  return { validador: "RR.HH.", area: "General", goToHR: true };
}
function empresaDe(e) {
  return String(e.empresa || e.emp || "").toUpperCase();
}
function construirOrganigrama(nomina, filtroEmpresa) {
  const lista = nomina.filter((e) => !filtroEmpresa || empresaDe(e) === filtroEmpresa.toUpperCase());
  const empPorNombre = {};
  for (const e of lista) empPorNombre[e.nom.toUpperCase().trim()] = e;
  const nodos = {};
  const getNodo = (nombre, area) => {
    if (!nodos[nombre]) nodos[nombre] = { nombre, area: area || "", empleado: empPorNombre[nombre] || null, directos: [], subManagers: {}, totalRecursivo: 0 };
    return nodos[nombre];
  };
  for (const emp of lista) {
    const v = getValidador({ ...emp, emp: empresaDe(emp) });
    if (!v || !v.validador) continue;
    getNodo(v.validador, v.area).directos.push({ emp, area: v.area });
  }
  const tieneSuperior = /* @__PURE__ */ new Set();
  for (const nombre of Object.keys(nodos)) {
    const emp = empPorNombre[nombre];
    if (!emp) continue;
    const v = getValidador({ ...emp, emp: empresaDe(emp) });
    if (!v || !v.validador || v.validador === nombre) continue;
    const superior = nodos[v.validador];
    if (superior) {
      superior.subManagers[nombre] = nodos[nombre];
      tieneSuperior.add(nombre);
    }
  }
  for (const nodo of Object.values(nodos)) {
    const subSet = new Set(Object.keys(nodo.subManagers));
    nodo.directos = nodo.directos.filter((d) => !subSet.has(d.emp.nom.toUpperCase().trim()));
  }
  const totalRecur = (nodo, vis) => {
    if (vis.has(nodo.nombre)) return 0;
    vis.add(nodo.nombre);
    let total = nodo.directos.length;
    for (const sub of Object.values(nodo.subManagers)) total += 1 + totalRecur(sub, vis);
    return total;
  };
  for (const nodo of Object.values(nodos)) nodo.totalRecursivo = totalRecur(nodo, /* @__PURE__ */ new Set());
  const raices = Object.keys(nodos).filter((n) => !tieneSuperior.has(n)).map((n) => nodos[n]).sort((a, b) => b.totalRecursivo - a.totalRecursivo);
  return { nodos, raices, totalEmpleados: lista.length };
}
export {
  construirOrganigrama,
  getValidador
};

// IDs de empleados a cargo de un gerente según el organigrama (su subárbol completo).
// empleados: [{ id, nom, lugar, cat, empresa, validador?, areaOrg?, area? }]
export function idsACargo(empleados, managerNom) {
  const mi = String(managerNom || '').toUpperCase().trim();
  if (!mi) return new Set();
  const nomina = empleados.map((e) => ({ ...e, emp: e.empresa || e.emp }));
  const { nodos } = construirOrganigrama(nomina);
  const nodo = nodos[mi];
  const ids = new Set();
  if (!nodo) return ids;
  const idPorNombre = {};
  for (const e of empleados) idPorNombre[String(e.nom).toUpperCase().trim()] = e.id;
  const recorrer = (n, prof) => {
    if (prof > 12) return;
    for (const d of n.directos) if (d.emp && d.emp.id != null) ids.add(d.emp.id);
    for (const k of Object.keys(n.subManagers)) {
      if (idPorNombre[k] != null) ids.add(idPorNombre[k]); // el sub-gerente también está a cargo
      recorrer(n.subManagers[k], prof + 1);
    }
  };
  recorrer(nodo, 0);
  return ids;
}
