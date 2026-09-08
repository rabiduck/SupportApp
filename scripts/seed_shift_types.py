from datetime import time

from app.database import SessionLocal
from app.models.rota import ShiftType

SHIFT_TYPES = [
    ("Off", "OFF", None, None, False),
    ("Early", "EARLY", time(8, 30), time(16, 30), True),
    ("Late", "LATE", time(9, 30), time(18, 0), True),
    ("Long Day", "LONG", time(8, 0), time(18, 0), True),
]


def main():
    db = SessionLocal()
    try:
        for name, code, start_time, end_time, is_working_day in SHIFT_TYPES:
            shift = db.query(ShiftType).filter(ShiftType.code == code).first()
            if not shift:
                shift = ShiftType(code=code)
                db.add(shift)
            shift.name = name
            shift.start_time = start_time
            shift.end_time = end_time
            shift.is_working_day = is_working_day
            shift.is_active = True
        db.commit()
        print("Shift type seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
