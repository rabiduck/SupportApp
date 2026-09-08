from app.database import SessionLocal
from app.models.department import Department
from app.models.team import Team  # noqa: F401 - registers relationship target

DEPARTMENTS = [
    ("Support", "Support services department"),
]


def main():
    db = SessionLocal()
    try:
        for name, description in DEPARTMENTS:
            department = db.query(Department).filter(Department.name == name).first()
            if not department:
                department = Department(name=name, description=description, is_active=True)
                db.add(department)
            else:
                department.description = description
                department.is_active = True
        db.commit()
        print("Department seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
