// Terminal colours in Ansible's output (AFD-79). Runs set ANSIBLE_FORCE_COLOR so the run terminal
// shows colour; where the same lines go to a log channel, the escape sequences would show as text
// ("ESC[0;31m"). The pattern is built from the character code so no escape sits in the source.
const ESC = String.fromCharCode(27);

/** CSI sequences: ESC [ parameters, intermediates, one final byte (colours, cursor moves). */
const CSI = new RegExp(`${ESC}[[][0-9;?]*[ -/]*[@-~]`, 'g');

/** The text without terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.includes(ESC) ? text.replace(CSI, '') : text;
}
