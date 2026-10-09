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
      cmid: i + 1,
      instance: i + 1,
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
    grades: demoGrades(now),
    details: demoDetails(tasks, now),
  };
}

// Calificaciones de ejemplo: [nombre, tipo, nota, máximo, hace N días, comentario]
const GRADES = {
  101: [7.1, [['Fulla 4: límits', 'assign', 8, 10, 1, 'Molt bé el plantejament. Vigila els signes al pas 3.'], ['Control: funcions', 'quiz', 6.5, 10, 6, ''], ['Fulla 3: successions', 'assign', 7, 10, 15, '']]],
  102: [5.6, [['Qüestionari tema 3: vectors', 'quiz', 4.2, 10, 3, ''], ['Informe: moviment rectilini', 'assign', 6.8, 10, 12, 'Falta la gràfica de velocitat. La resta, correcte.']]],
  103: [8.4, [['Fitxa: el Partenó', 'assign', 9, 10, 2, 'Excel·lent anàlisi formal.'], ['Test del Romànic', 'quiz', 7.8, 10, 18, '']]],
  104: [6.3, [['Comentari: Bécquer', 'assign', 6, 10, 9, 'Bona interpretació, però cal revisar l\'ortografia.'], ['Lectura: La casa de Bernarda Alba', 'quiz', 6.6, 10, 25, '']]],
  105: [8.9, [['Writing: a formal email', 'assign', 9.25, 10, 4, 'Great structure and vocabulary.'], ['Listening unit 4', 'quiz', 8.5, 10, 11, '']]],
  106: [7.6, [['Pràctica 2: layout amb CSS Grid', 'assign', 82, 100, 5, 'Bon ús de grid-template-areas. Millora el responsive.'], ['Test: selectors CSS', 'quiz', 7, 10, 20, '']]],
};

function fmt(n) {
  return Number.isInteger(n) ? n.toFixed(2).replace('.', ',') : String(Math.round(n * 100) / 100).replace('.', ',');
}

function demoGrades(now) {
  const courses = {};
  let id = 1;
  Object.entries(GRADES).forEach(([cid, [total, items]]) => {
    courses[cid] = {
      total: { formatted: fmt(total), raw: total, min: 0, max: 10, pct: total / 10 },
      items: items.map(([name, module, raw, max, days, feedback]) => ({
        id: id++,
        name,
        module,
        instance: 0,
        cmid: 0,
        formatted: fmt(raw),
        raw,
        min: 0,
        max,
        pct: raw / max,
        feedback,
        graded: now - days * D - 3 * H,
        submitted: now - (days + 2) * D,
        weight: '',
      })),
    };
  });
  return { at: now, courses };
}

function demoDetails(tasks, now) {
  const assign = {};
  const quiz = {};
  const sub = {};
  tasks.forEach((t) => {
    if (t.kind === 'assign') {
      assign[t.instance] = { maxGrade: t.courseId === 106 ? 100 : 10, scale: false, cutoff: t.due < now ? t.due + 3 * D : 0, opens: 0, files: t.instance % 3 === 0 ? 1 : 0, attempts: null };
      sub[t.instance] = { status: t.instance === 3 || t.instance === 1 ? 'draft' : 'new', modified: t.instance === 3 ? now - 5 * H : 0, graded: false, grade: '', gradedAt: 0, feedback: '', extension: 0 };
    }
    if (t.kind === 'quiz') quiz[t.instance] = { timeLimit: t.courseId === 102 ? 1800 : 2700, attempts: t.courseId === 103 ? 0 : 1, opens: 0, closes: t.due, maxGrade: 10 };
  });
  return { assign, quiz, sub };
}
