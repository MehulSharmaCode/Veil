// Submit-like controls always need local user confirmation, whatever the planner says.

const SUBMIT_WORDS =
  /\b(submit|save|confirm|apply|register|sign ?up|pay|send|delete|remove|place ?order|checkout|check ?out|purchase|buy|transfer|publish|post|book|proceed to pay|finish|continue to payment)\b/i;

export interface SubmitLikeInput {
  tag: string;
  role: string;
  input_type?: string;
  state: { submitter?: boolean };
  name: string;
  text: string;
}

export function isSubmitLike(el: SubmitLikeInput): boolean {
  if (el.input_type === 'submit' || el.input_type === 'image') return true;
  if (el.state.submitter) return true;
  const clickable = el.role === 'button' || el.role === 'link' || el.role === 'menuitem' || el.tag === 'button' || el.tag === 'a' || el.tag === 'input';
  return clickable && (SUBMIT_WORDS.test(el.name) || SUBMIT_WORDS.test(el.text));
}
