// Datos de ejemplo para probar la app sin conectar ningún Moodle.
// Se generan relativos al momento actual y nunca se guardan en disco.

const H = 3_600_000;
const D = 24 * H;

// Nombres cortos como los que pone Moodle en los institutos (códigos de grupo y curso).
const COURSES = [
  { id: 101, fullname: 'Matemàtiques II', shortname: '2BAT_MAT_B_2526', progress: 64 },
  { id: 102, fullname: 'Física', shortname: '2BAT_FIS_2526', progress: 48 },
  { id: 103, fullname: "Història de l'Art", shortname: 'HART', progress: 71 },
  { id: 104, fullname: 'Llengua Castellana i Literatura', shortname: '2BAT-LCL-2526', progress: 55 },
  { id: 105, fullname: 'Anglès B2', shortname: 'ANG', progress: 82 },
  { id: 106, fullname: 'Programació Web', shortname: 'PWEB', progress: 37 },
];

function at(now, days, hour, minute = 0) {
  const d = new Date(now + days * D);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const DESC = {
  form: "Feu un formulari d'inscripció accessible: etiquetes visibles, missatges d'error al costat de cada camp i validació amb JavaScript.\nLliureu un ZIP amb l'HTML, el CSS i el JS.",
  cinematica: 'Qüestionari de 10 preguntes sobre MRU i MRUA. Teniu un sol intent i 30 minuts.',
  derivades: 'Exercicis 1 a 12 de la fulla 6. Pugeu una foto o un PDF amb tot el procediment.',
  debate: 'Write at least 120 words with your opinion and reply to two classmates.',
  bohemia: 'Comentari de l\'escena XII. Extensió màxima: dues cares. Format PDF.',
  renaixement: 'Test de 15 preguntes sobre el Quattrocento i el Cinquecento.',
  pendol: 'Informe amb objectius, material, procediment, taula de dades, gràfica T² enfront de L i conclusions.',
};

export function demoData(now = Date.now()) {
  const c = Object.fromEntries(COURSES.map((x) => [x.id, x]));
  // [curso, tipo, título, días, hora, minuto, acción, descripción, ¿admite entregas?]
  const rows = [
    [106, 'assign', 'Pràctica 3: formulari accessible amb validació', -2, 23, 59, 'Afegeix una tramesa', DESC.form, true],
    [102, 'quiz', 'Qüestionari tema 4: cinemàtica', -1, 20, 0, 'Fes el qüestionari', DESC.cinematica, false],
    [101, 'assign', 'Exercicis de derivades (fulla 6)', 0, 23, 59, 'Afegeix una tramesa', DESC.derivades, true],
    [105, 'forum', 'Debate: social media and teenagers', 0, 18, 0, 'Respon', DESC.debate, true],
    [104, 'assign', 'Comentari de text: Luces de bohemia', 1, 14, 0, 'Afegeix una tramesa', DESC.bohemia, true],
    [103, 'quiz', 'Test del Renaixement italià', 2, 22, 0, 'Fes el qüestionari', DESC.renaixement, true],
    [106, 'workshop', 'Avaluació entre iguals: projecte CSS', 3, 23, 59, 'Avalua', '', true],
    [102, 'assign', 'Informe de laboratori: pèndol simple', 4, 9, 0, 'Afegeix una tramesa', DESC.pendol, true],
    [101, 'quiz', 'Control en línia: integrals immediates', 6, 12, 30, 'Fes el qüestionari', '', false],
    [105, 'assign', 'Writing task: opinion essay (250 words)', 8, 23, 59, 'Afegeix una tramesa', '', true],
    [103, 'assign', "Fitxa d'obra: Las Meninas", 10, 23, 59, 'Afegeix una tramesa', '', true],
    [104, 'forum', 'Fòrum: lectures recomanades del trimestre', 12, 20, 0, 'Respon', '', true],
    [106, 'assign', 'Projecte final: aplicació SPA', 19, 23, 59, 'Afegeix una tramesa', '', true],
  ];
  const tasks = rows.map(([cid, kind, title, days, h, m, action, description, actionable], i) => {
    const due = at(now, days, h, m);
    return {
      id: 'demo' + (i + 1),
      title,
      kind,
      kindLabel: '',
      courseId: cid,
      courseName: c[cid].fullname,
      courseShort: c[cid].shortname,
      due,
      overdue: due < now,
      url: null,
      actionName: action,
      actionable,
      cmid: 0,
      eventtype: 'due',
      description,
      source: 'demo',
    };
  });
  const history = [
    { id: 'demo-h1', title: 'Resum del tema 3', kind: 'assign', courseId: 103, courseName: c[103].fullname, courseShort: c[103].shortname, due: now - 3 * D, completedAt: now - 4 * D, how: 'gone', source: 'demo', url: null },
    { id: 'demo-h2', title: 'Listening practice unit 5', kind: 'quiz', courseId: 105, courseName: c[105].fullname, courseShort: c[105].shortname, due: now - 1 * D, completedAt: now - 2 * D, how: 'gone', source: 'demo', url: null },
    { id: 'demo-h3', title: 'Qüestionari de repàs: vectors', kind: 'quiz', courseId: 102, courseName: c[102].fullname, courseShort: c[102].shortname, due: now - 5 * D, completedAt: now - 5 * D, how: 'expired', source: 'demo', url: null },
  ];
  return {
    site: { url: 'https://moodle.exemple.cat', name: 'Institut de mostra', userName: 'Laia Ferrer Puig', firstName: 'Laia', userId: 0, lang: 'ca' },
    tasks,
    courses: COURSES,
    history,
  };
}
