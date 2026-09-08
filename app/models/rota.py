"""Rota models.

Defines reusable rota patterns and shift types.
"""

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Time
from sqlalchemy.orm import relationship

from app.database import Base


class ShiftType(Base):
    __tablename__ = "shift_types"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False)
    code = Column(String(20), unique=True, nullable=False)
    start_time = Column(Time, nullable=True)
    end_time = Column(Time, nullable=True)
    is_working_day = Column(Boolean, default=True, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class RotaPattern(Base):
    __tablename__ = "rota_patterns"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(String(255), nullable=True)
    cycle_length_weeks = Column(Integer, default=1, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    days = relationship(
        "RotaPatternDay",
        back_populates="rota_pattern",
        cascade="all, delete-orphan",
    )


class RotaPatternDay(Base):
    __tablename__ = "rota_pattern_days"

    id = Column(Integer, primary_key=True, index=True)
    rota_pattern_id = Column(Integer, ForeignKey("rota_patterns.id"), nullable=False)
    shift_type_id = Column(Integer, ForeignKey("shift_types.id"), nullable=False)
    week_number = Column(Integer, nullable=False)
    day_of_week = Column(Integer, nullable=False)

    rota_pattern = relationship("RotaPattern", back_populates="days")
    shift_type = relationship("ShiftType")
