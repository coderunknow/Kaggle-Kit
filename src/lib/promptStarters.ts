/**
 * Prompt starters of an empty conversation.
 *
 * They are plain text: a click fills the composer and focuses it. Nothing is
 * sent automatically, so the user can edit the prompt first.
 */

export interface PromptStarter {
  id: string;
  title: string;
  description: string;
  prompt: string;
}

export const PROMPT_STARTERS: PromptStarter[] = [
  {
    id: 'explain',
    title: 'Explain a concept',
    description: 'A clear explanation with an example.',
    prompt: 'Explain how a hash table works, with a small Python example.',
  },
  {
    id: 'code-review',
    title: 'Review code',
    description: 'Find bugs and suggest a fix.',
    prompt: 'Review this code and point out the bugs and the risks:\n\n```python\n',
  },
  {
    id: 'debug',
    title: 'Debug an error',
    description: 'Work from the exact message and stack trace.',
    prompt: 'Help me debug this error. Here is the message and what I tried:\n\n',
  },
  {
    id: 'summarize',
    title: 'Summarise notes',
    description: 'Turn long notes into a short summary.',
    prompt: 'Summarise the following notes in five bullet points:\n\n',
  },
];
