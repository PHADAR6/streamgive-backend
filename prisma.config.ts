import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const DEFAULT_DATABASE_URL = 'postgresql://streamgive:streamgive@localhost:5432/streamgive';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
});
