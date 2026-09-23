// Used by test/import-without-credentials.test.mjs. Importing this actually
// builds a client, which must fail when SKILLJAR_API_KEY is unset — that is
// what keeps the "loads without credentials" test from passing vacuously
// should the key requirement ever be dropped.
import { createSkilljarClient } from '../../scripts/skilljar-client.mjs';

createSkilljarClient();
