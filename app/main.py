from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.routes import auth, dashboard, employees, teams, users

app = FastAPI(title="Support Portal")
app.add_middleware(
    SessionMiddleware,
    secret_key="change-this-development-secret",
    same_site="lax",
    https_only=False,
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(users.router)
app.include_router(teams.router)
app.include_router(employees.router)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code == 401:
        return RedirectResponse(url="/login", status_code=303)
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(str(exc.detail), status_code=exc.status_code)
