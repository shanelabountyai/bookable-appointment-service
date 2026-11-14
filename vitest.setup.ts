// K12 (INV-18): refuse to start the suite against a non-local database. Runs
// before every test file, so a file that opens its own pg Client (constraint,
// races) is covered as well as everything that goes through resetDatabase.
import { assertLocalDatabase } from './packages/db/testing/local-guard';

if (process.env.DATABASE_URL) assertLocalDatabase(process.env.DATABASE_URL);
