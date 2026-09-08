from app.database import Base, engine
from app.models import Department, Employee, Permission, Role, RotaPattern, RotaPatternDay, ShiftType, Team, User  # noqa: F401


def main():
    Base.metadata.create_all(bind=engine)
    print("Database initialised.")


if __name__ == "__main__":
    main()
