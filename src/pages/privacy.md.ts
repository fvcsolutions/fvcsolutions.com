import markdown from '../content/legal/privacy-policy.md?raw';

export const GET = () =>
  new Response(markdown, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
