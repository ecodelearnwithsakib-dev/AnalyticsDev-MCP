import { createInterface } from "node:readline";

/** Reads one line from the terminal. With `hidden`, typed characters are not echoed (for secrets). */
export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stderr.write(s);
        else if (s.includes("\n") || s.includes("\r")) process.stderr.write("\n");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      done(answer.trim());
    });
  });
}
