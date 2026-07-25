# MTG warehouse transformations

This dbt project transforms the PostgreSQL `bronze` source tables into indexed `silver`
and `gold` models used by the API.

From the repository root:

```bash
set -a
source .env
set +a

.venv/bin/dbt deps --project-dir dbt --profiles-dir dbt
.venv/bin/dbt build --project-dir dbt --profiles-dir dbt
```

Connection values come from the root `.env` through `dbt/profiles.yml`.
