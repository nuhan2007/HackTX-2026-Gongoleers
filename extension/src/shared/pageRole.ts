// Which page is the HOMEWORK (the problem) and which is the WORK (where the student writes the solution)? One signal is never
// trusted on its own. Each page is scored from several independent indicators and the scores explain themselves, so the side
// panel can say why myTA believes what it believes:
//   - the site: a known drawing board / whiteboard / notes / document / code editor, or a known homework platform
//   - the page's structure: a canvas filling the screen, a toolbar of drawing tools, a big empty text area, versus answer boxes,
//     a "Check" button, numbered questions and paragraphs of problem text
//   - what the student actually does there: typing and pen/mouse strokes
// Pure functions, no browser APIs: the content script measures the structure (`RoleHints`), the background adds the rest.

/** What a page looks like, measured in the page itself (see content/roleHints.ts). */
export interface RoleHints {
  /** The largest visible <canvas> as a share of the window, 0..1. */
  canvasShare: number;
  /** The largest visible text area / editable region (not a one-line field) as a share of the window, 0..1. */
  editorShare: number;
  /** Visible controls that look like drawing tools: pen, eraser, brush, shapes, undo, colors, … */
  toolButtons: number;
  /** Visible places to type an answer (one-line fields, choices) or a "Check" button. */
  answerFields: number;
  /** A visible "Check", "Submit answer" or similar button. */
  checkButton: boolean;
  /** Different numbered questions on screen ("Q3", "Problem 2", "Question 4"). */
  questionLabels: number;
  /** How much text is on screen (capped), a problem page has paragraphs and a board has almost none. */
  textLen: number;
  /** Words and symbols a problem statement is full of: solve, find, calculate, evaluate, =, ?, … */
  problemCues: number;
}

export const EMPTY_HINTS: RoleHints = { canvasShare: 0, editorShare: 0, toolButtons: 0, answerFields: 0, checkButton: false, questionLabels: 0, textLen: 0, problemCues: 0 };

interface Site {
  re: RegExp;
  /** What to call it when explaining ("a drawing board"). */
  what: string;
}

/** Places a student writes out a solution: boards, whiteboards, notes, documents, code editors. */
export const WORK_SITES: Site[] = [
  { re: /(^|\.)sketch\.io$/, what: 'a drawing board' },
  { re: /(^|\.)(excalidraw\.com|tldraw\.com|tldraw\.dev|whiteboard\.fi|aww\.app|awwapp\.com|ziteboard\.com|bitpaper\.io|scribblar\.com|witeboard\.com|jspaint\.app|sketchpad\.app|autodraw\.com|kleki\.com|miniPaint\.com|excalidraw\.dev)$/i, what: 'a drawing board' },
  { re: /(^|\.)(miro\.com|mural\.co|figma\.com|canva\.com|lucid\.app|lucidspace\.com|padlet\.com|jamboard\.google\.com|whiteboard\.microsoft\.com|whiteboard\.office\.com|diagrams\.net|draw\.io)$/i, what: 'a whiteboard' },
  { re: /(^|\.)(onenote\.com|notion\.so|evernote\.com|goodnotes\.com|notability\.com|kami\.app|obsidian\.md|roamresearch\.com|remnote\.com|quip\.com|dropbox\.com)$/i, what: 'a notes app' },
  { re: /^docs\.google\.com$/, what: 'a document' },
  { re: /(^|\.)(word\.office\.com|office\.live\.com|onedrive\.live\.com|sharepoint\.com|overleaf\.com|paper\.dropbox\.com|hackmd\.io|stackedit\.io)$/i, what: 'a document editor' },
  { re: /(^|\.)(desmos\.com|geogebra\.org|mathcha\.io|mathquill\.com|latex\.codecogs\.com)$/i, what: 'a math workspace' },
  { re: /(^|\.)(replit\.com|codesandbox\.io|stackblitz\.com|jupyter\.org|colab\.research\.google\.com|codepen\.io|jsfiddle\.net|glitch\.com|onlinegdb\.com|programiz\.com|w3schools\.com|pythontutor\.com|trinket\.io)$/i, what: 'a code editor' },
];

/** Places a student is GIVEN problems: homework platforms, practice sites, course pages. */
export const HOMEWORK_SITES: Site[] = [
  { re: /(^|\.)(khanacademy\.org|ixl\.com|brilliant\.org|deltamath\.com|webassign\.net|aleks\.com|edulastic\.com|mathantics\.com|artofproblemsolving\.com|ck12\.org|openstax\.org|mathspace\.co|prodigygame\.com|zearn\.org|xtramath\.org|sumdog\.com|mathigon\.org|study\.com|illustrativemathematics\.org|kutasoftware\.com|mathisfun\.com|cymath\.com|sapling\.com|saplinglearning\.com|wileyplus\.com|knewton\.com|alta\.knewton\.com|lon-capa\.org|mymathlab\.com|mylab\.pearson\.com|mastering\.pearson\.com|connect\.mheducation\.com|cengage\.com|achieve3000\.com|edmentum\.com|buzzmath\.com|kahoot\.com|quizizz\.com|gimkit\.com|edpuzzle\.com)$/i, what: 'a homework site' },
  { re: /(^|\.)(canvas\.[a-z.]+|instructure\.com|schoology\.com|blackboard\.com|classroom\.google\.com|moodle\.[a-z.]+|brightspace\.com|d2l\.com|edx\.org|coursera\.org|udemy\.com|codecademy\.com|leetcode\.com|hackerrank\.com|codeforces\.com|codewars\.com|exercism\.org|freecodecamp\.org|datacamp\.com|checkio\.org|projecteuler\.net|acmicpc\.net|kattis\.com)$/i, what: 'a course or practice site' },
];

const siteOf = (host: string, list: Site[]): Site | null => list.find((s) => s.re.test(host)) ?? null;

const hostAndPath = (url: string): { host: string; path: string } | null => {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ''), path: u.pathname };
  } catch {
    return null;
  }
};

export interface RoleScore {
  /** 0..1: how sure we are this is where the student writes their solution. */
  work: number;
  /** 0..1: how sure we are this page is where problems are given. */
  problem: number;
  /** Why, one short clause per indicator that counted. Safe to show. */
  workWhy: string[];
  problemWhy: string[];
}

/** Typing and drawing the student did on this page recently (keystrokes + weighted strokes); see tabRoles. */
export interface RoleInput {
  recent: number;
  /** Counts as work-like input at all. */
  min: number;
  /** Strong evidence of someone writing here. */
  strong: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Scores one page. `hints` may be missing (a PDF, a page that hasn't reported yet): then only the site and the input count, and
 * a page nothing is known about scores low on both, i.e. "can't tell".
 */
export function scoreRole(url: string, title: string, hints: RoleHints | null, input: RoleInput): RoleScore {
  const h = hints ?? EMPTY_HINTS;
  const where = hostAndPath(url);
  const workWhy: string[] = [];
  const problemWhy: string[] = [];
  let work = 0;
  let problem = 0;

  // ---- the site ----
  const workSite = where ? siteOf(where.host, WORK_SITES) : null;
  const homeSite = where ? siteOf(where.host, HOMEWORK_SITES) : null;
  // Google Docs is only a work page when it is a document, drawing or slide (not the Docs home page of file icons).
  const docsOk = !where || where.host !== 'docs.google.com' || /^\/(document|drawings|presentation|spreadsheets)\/d\//.test(where.path);
  if (workSite && docsOk) {
    work += 0.6;
    workWhy.push(`it's ${workSite.what} (${where!.host})`);
  }
  if (homeSite) {
    problem += 0.55;
    problemWhy.push(`it's ${homeSite.what} (${where!.host})`);
    work -= 0.5;
  }
  if (/\b(sketch\w*|whiteboard|draw\w*|canvas|notebook|scratch\w*|paint\w*|board)\b/i.test(title)) {
    work += 0.15;
    workWhy.push('the page title says it is a board or notebook');
  }
  if (/\b(practice|exercise|quiz|homework|assignment|problem set|worksheet|lesson|question)\b/i.test(title)) {
    problem += 0.1;
    problemWhy.push('the page title says it is practice or homework');
  }

  // ---- the page's structure ----
  if (h.canvasShare >= 0.35) {
    work += h.canvasShare >= 0.6 ? 0.55 : 0.4;
    workWhy.push(`a canvas fills ${Math.round(h.canvasShare * 100)}% of the screen`);
  }
  if (h.toolButtons >= 3) {
    work += 0.25;
    workWhy.push('it has drawing tools (pen, eraser, colors, …)');
  }
  if (h.editorShare >= 0.3 && !h.checkButton) {
    work += h.editorShare >= 0.5 ? 0.5 : 0.3;
    workWhy.push('a large writing area takes up the page');
  }
  if (h.checkButton) {
    problem += 0.25;
    problemWhy.push('it has a "Check" / "Submit" button');
    work -= 0.25;
  }
  if (h.answerFields > 0 && h.canvasShare < 0.35) {
    problem += 0.2;
    problemWhy.push('it has a box to type an answer in');
  }
  if (h.questionLabels >= 1) {
    problem += 0.2;
    problemWhy.push('it has numbered questions');
  }
  if (h.textLen > 500 && h.problemCues >= 2) {
    problem += 0.2;
    problemWhy.push('it is mostly a problem statement');
  }
  if (h.canvasShare >= 0.4) problem -= 0.4;

  // ---- what the student does there ----
  if (input.recent >= input.min) {
    work += 0.5;
    workWhy.push('you have been writing or drawing here');
    if (input.recent >= input.strong) {
      work += 0.2;
      workWhy.push('a lot of it');
    }
  }

  return { work: clamp01(work), problem: clamp01(problem), workWhy, problemWhy };
}

export type PageRole = 'work' | 'problem' | 'unknown';

/** The page's role from its scores: one has to be both sure enough and clearly ahead of the other. */
export function roleOf(s: Pick<RoleScore, 'work' | 'problem'>, sure = 0.5, margin = 0.15): PageRole {
  if (s.work >= sure && s.work >= s.problem + margin) return 'work';
  if (s.problem >= sure && s.problem >= s.work + margin) return 'problem';
  return 'unknown';
}

/** A short statement of why, for the side panel: the indicators that counted for the role this page was given. */
export function whyText(role: PageRole, s: RoleScore): string[] {
  return role === 'work' ? s.workWhy : role === 'problem' ? s.problemWhy : [];
}
