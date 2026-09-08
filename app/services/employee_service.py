from typing import Optional

from sqlalchemy.orm import Session

from app.models.employee import Employee


def _validate_user_link(db: Session, user_id: Optional[int], employee_id: Optional[int] = None) -> None:
    if user_id is None:
        return
    query = db.query(Employee).filter(Employee.user_id == user_id)
    if employee_id is not None:
        query = query.filter(Employee.id != employee_id)
    if query.first():
        raise ValueError("That user account is already linked to another employee.")


def create_employee(
    db: Session,
    display_name: str,
    user_id: Optional[int],
    team_id: int,
    job_title: Optional[str],
    phone: Optional[str],
) -> Employee:
    _validate_user_link(db, user_id)
    employee = Employee(
        display_name=display_name.strip(),
        user_id=user_id,
        team_id=team_id,
        job_title=job_title.strip() if job_title else None,
        phone=phone.strip() if phone else None,
        is_active=True,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee


def update_employee(
    db: Session,
    employee_id: int,
    display_name: str,
    user_id: Optional[int],
    team_id: int,
    job_title: Optional[str],
    phone: Optional[str],
    is_active: bool,
) -> Employee:
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise ValueError("Employee not found.")

    _validate_user_link(db, user_id, employee_id)
    employee.display_name = display_name.strip()
    employee.user_id = user_id
    employee.team_id = team_id
    employee.job_title = job_title.strip() if job_title else None
    employee.phone = phone.strip() if phone else None
    employee.is_active = is_active
    db.commit()
    db.refresh(employee)
    return employee


def deactivate_employee(db: Session, employee_id: int) -> Employee:
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise ValueError("Employee not found.")
    return update_employee(
        db=db,
        employee_id=employee.id,
        display_name=employee.display_name,
        user_id=employee.user_id,
        team_id=employee.team_id,
        job_title=employee.job_title,
        phone=employee.phone,
        is_active=False,
    )


def activate_employee(db: Session, employee_id: int) -> Employee:
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise ValueError("Employee not found.")
    return update_employee(
        db=db,
        employee_id=employee.id,
        display_name=employee.display_name,
        user_id=employee.user_id,
        team_id=employee.team_id,
        job_title=employee.job_title,
        phone=employee.phone,
        is_active=True,
    )
