# app/api/__init__.py
# Makes 'api' a Python package.
# All routers are registered here and imported into main.py.

from app.api.auth    import router as auth_router
from app.api.markets import router as markets_router
from app.api.signals import router as signals_router
from app.api.orders  import router as orders_router