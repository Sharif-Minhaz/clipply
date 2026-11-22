import { createServer } from 'node:http';

import handler from './vercel';

// Local development: `npm run dev -w @clipply/server` with a filled-in .env (see .env.example).
const port = Number(process.env.PORT ?? 8787);
createServer((req, res) => void handler(req, res)).listen(port, () => console.log(`clipply api on http://localhost:${port}/v1/health`));
