# SupportApp

Internal support administration portal built with FastAPI, SQLAlchemy and Jinja2.

## Development setup

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m scripts.init_db
python -m scripts.seed_rbac
python -m scripts.seed_departments
python -m scripts.seed_shift_types
python -m scripts.create_admin
python -m uvicorn app.main:app --reload --host 0.0.0.0
```

The development database is stored at `instance/support_portal.sqlite`.

## Current modules

- Local session authentication
- Role based access control
- User administration
- Department and team administration
- Employee administration and optional user linking
- Initial rota/shift pattern data model

The rota viewer, rota editing and on-call modules are not yet implemented.
