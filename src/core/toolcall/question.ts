// The Question tool: the model asks the user; the answer, written by the user, is its Tool Result.
export type QuestionOption = { label: string; description: string };
// recommended: the label of the Recommended Option; a list of labels only when `multiple`.
export type Question = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; recommended: string | string[] };

export const QUESTION_DEFINITION = {
  name: 'question',
  description:
    'Ask the user one or more questions and wait for the answers. Give each question at least 2 options and always a recommendation: ' +
    '`recommended` is the label of the option you advise (a list of labels only when `multiple`). The user can always type an own answer, ' +
    'so never add an "Other" option.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'the full question' },
            header: { type: 'string', description: 'a very short label' },
            options: {
              type: 'array',
              minItems: 2,
              items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'description'] },
            },
            multiple: { type: 'boolean', description: 'several options may be chosen' },
            recommended: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'label(s) of the recommended option(s)' },
          },
          required: ['question', 'header', 'options', 'recommended'],
        },
      },
    },
    required: ['questions'],
  },
};

const isText = (v: unknown): v is string => typeof v === 'string';
const MISSING = 'recommended is missing – give the label of the Recommended Option';

// Why a question cannot be asked, or null.
const problemOf = (q: Record<string, unknown>): string | null => textProblem(q) ?? optionsProblem(q.options) ?? recommendedProblem(q);
const textProblem = (q: Record<string, unknown>) => (isText(q.question) && isText(q.header) ? null : 'question and header must be strings');
function optionsProblem(options: unknown): string | null {
  if (!Array.isArray(options) || options.length < 2) return 'at least 2 options';
  return options.every(o => isText(o?.label) && isText(o.description)) ? null : 'every option needs a label and a description';
}
// Options are valid by now.
function recommendedProblem({ recommended, multiple, options }: Record<string, unknown>): string | null {
  if (Array.isArray(recommended) && !multiple) return 'recommended is a list, but multiple is not set';
  const labels = [recommended].flat();
  if (!labels.length || !labels.every(isText)) return MISSING;
  const unknown = labels.find(l => !(options as QuestionOption[]).some(o => o.label === l));
  return unknown === undefined ? null : `recommended "${unknown}" is not an option label`;
}

// The questions argument as a list; small models often send it as a JSON string of the list.
const listOf = (questions: unknown): unknown => (isText(questions) ? JSON.parse(questions) : questions);

// The questions of a Question call, or why it is rejected back to the model.
export function parseQuestions(args: unknown): { questions: Question[] } | { error: string } {
  let questions: unknown;
  try {
    questions = listOf((args as { questions?: unknown } | null)?.questions);
  } catch {
    return { error: 'questions is a string, but no JSON list' };
  }
  if (!Array.isArray(questions) || !questions.length) return { error: 'questions must be a non-empty list' };
  for (const [i, q] of questions.entries()) {
    const problem = problemOf((q ?? {}) as Record<string, unknown>);
    if (problem) return { error: `question ${i + 1}: ${problem}` };
  }
  return { questions: questions as Question[] };
}

// The questions of a stored Question call (its content: the arguments as JSON).
export const questionsOf = (content: string): Question[] => listOf((JSON.parse(content) as { questions: unknown }).questions) as Question[];

// An answer: the chosen labels and the own answer, if any; none when the question was skipped.
export type Answer = string[];
// Tool Result of an answered Question: one line per question, `<full question text>: <answer>`, several comma-separated.
// It does not say whether the user followed the recommendation.
export const answerText = (questions: Question[], answers: Answer[]): string => questions.map((q, i) => `${q.question}: ${shownAnswer(answers[i]!)}`).join('\n');
export const shownAnswer = (answer: Answer) => (answer.length ? answer.join(', ') : 'Unanswered');

// The options as the dock lists them: the Recommended Option(s) first, then the others in the model's order.
export const orderedOptions = (q: Question): QuestionOption[] =>
  [...q.options.filter(o => isRecommended(q, o)), ...q.options.filter(o => !isRecommended(q, o))];
export const isRecommended = (q: Question, option: QuestionOption) => [q.recommended].flat().includes(option.label);

// A Question's title: its question texts; content that is no Question as is.
export function questionTitle(content: string): string {
  try {
    return questionsOf(content).map(q => q.question).join(' · ');
  } catch {
    return content;
  }
}
