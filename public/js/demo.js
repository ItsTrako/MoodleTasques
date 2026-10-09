// Datos de ejemplo para probar la app sin conectar ningún Moodle.
// Se generan relativos al momento actual y nunca se guardan en disco.

const H = 3_600_000;
const D = 24 * H;

const COURSES = [
  { id: 101, fullname: 'Matemàtiques II', shortname: 'MAT2', progress: 64 },
  { id: 102, fullname: 'Física', shortname: 'FIS', progress: 48 },
  { id: 103, fullname: "Història de l'Art", shortname: 'HART', progress: 71 },
  { id: 104, fullname: 'Llengua Castellana i Literatura', shortname: 'LCL', progress: 55 },
  { id: 105, fullname: 'Anglès B2', shortname: 'ANG', progress: 82 },
  { id: 106, fullname: 'Programació Web', shortname: 'PWEB', progress: 37 },
];

function at(now, days, hour, minute = 0) {
  const d = new Date(now + days * D);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

export function demoData(now = Date.now()) {
  const c = Object.fromEntries(COURSES.map((x) => [x.id, x]));
  const rows = [
    [106, 'assign', 'Pràctica 3: formulari accessible amb validació', -2, 23, 59, 'Entregar'],
    [102, 'quiz', 'Qüestionari tema 4: cinemàtica', -1, 20, 0, 'Fer el qüestionari'],
    [101, 'assign', 'Exercicis de derivades (fulla 6)', 0, 23, 59, 'Entregar'],
    [105, 'forum', 'Debate: social media and teenagers', 0, 18, 0, 'Respondre'],
    [104, 'assign', 'Comentari de text: Luces de bohemia', 1, 14, 0, 'Entregar'],
    [103, 'quiz', 'Test del Renaixement italià', 2, 22, 0, 'Fer el qüestionari'],
    [106, 'workshop', 'Avaluació entre iguals: projecte CSS', 3, 23, 59, 'Avaluar'],
    [102, 'assign', 'Informe de laboratori: pèndol simple', 4, 9, 0, 'Entregar'],
    [101, 'quiz', 'Control en línia: integrals immediates', 6, 12, 30, 'Fer el qüestionari'],
    [105, 'assign', 'Writing task: opinion essay (250 words)', 8, 23, 59, 'Entregar'],
    [103, 'assign', 'Fitxa d’obra: Las Meninas', 10, 23, 59, 'Entregar'],
    [104, 'forum', 'Fòrum: lectures recomanades del trimestre', 12, 20, 0, 'Respondre'],
    [106, 'assign', 'Projecte final: aplicació SPA', 19, 23, 59, 'Entregar'],
  ];
  const tasks = rows.map(([cid, kind, title, days, h, m, action], i) => {
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
      source: 'demo',
    };
  });
  const history = [
    { id: 'demo-h1', title: 'Resum del tema 3', kind: 'assign', courseId: 103, courseName: c[103].fullname, courseShort: 'HART', due: now - 3 * D, completedAt: now - 4 * D, how: 'moodle', source: 'demo', url: null },
    { id: 'demo-h2', title: 'Listening practice unit 5', kind: 'quiz', courseId: 105, courseName: c[105].fullname, courseShort: 'ANG', due: now - 1 * D, completedAt: now - 2 * D, how: 'moodle', source: 'demo', url: null },
  ];
  return {
    site: { url: 'https://moodle.exemple.cat', name: 'Institut Les Corts (demostració)', userName: 'Laia Ferrer Puig', userId: 0 },
    tasks,
    courses: COURSES,
    history,
  };
}
