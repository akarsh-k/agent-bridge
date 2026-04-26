import { defineConfig } from 'drizzle-kit'

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://agentbridge:agentbridge_dev_password@127.0.0.1:5432/agentbridge'

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: connectionString },
  strict: true,
  verbose: true,
})
