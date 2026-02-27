"""
FX Radiant — Order Models
===========================
Pydantic schemas for trade order requests and responses.
These validate the data going to and coming back from
the Oanda v20 Orders API.
"""

from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field, model_validator


# ── Order request ─────────────────────────────────────────────────────────────

class OrderRequest(BaseModel):
    """
    Sent by the frontend to POST /api/orders.
    units is positive for a long (buy) trade, negative for a short (sell).
    stop_loss and take_profit are the actual price levels, not pips.
    """
    instrument:  str   = Field(description="e.g. EUR_USD")
    units:       int   = Field(description="Positive = LONG, Negative = SHORT")
    stop_loss:   float = Field(description="SL price level")
    take_profit: float = Field(description="TP price level")

    @model_validator(mode="after")
    def validate_levels(self) -> "OrderRequest":
        """Basic sanity check: SL and TP must be on opposite sides of zero."""
        if self.units > 0 and self.stop_loss >= self.take_profit:
            raise ValueError("For a LONG order, stop_loss must be below take_profit")
        if self.units < 0 and self.stop_loss <= self.take_profit:
            raise ValueError("For a SHORT order, stop_loss must be above take_profit")
        return self


# ── Order response ────────────────────────────────────────────────────────────

class OrderFill(BaseModel):
    """
    Details of a successfully filled order.
    Maps directly to the Oanda orderFillTransaction response.
    """
    id:           str
    instrument:   str
    units:        str
    price:        str
    pl:           str = Field(default="0.0", description="Profit/Loss")
    financing:    str = Field(default="0.0")
    commission:   str = Field(default="0.0")
    account_balance: Optional[str] = Field(default=None)


class OrderResponse(BaseModel):
    """
    Returned by POST /api/orders on success.
    The relatedTransactionIDs list contains the IDs of the SL/TP orders.
    """
    order_fill:              Optional[OrderFill] = None
    related_transaction_ids: list[str]           = []
    last_transaction_id:     str                 = ""


# ── Position (for Account page) ───────────────────────────────────────────────

class OpenPosition(BaseModel):
    """
    One open position as shown on the Account page.
    Data comes from GET /api/account/positions.
    """
    instrument:     str
    long_units:     int   = 0
    short_units:    int   = 0
    unrealised_pl:  float = 0.0
    average_price:  float = 0.0

    @property
    def direction(self) -> Literal["LONG", "SHORT", "FLAT"]:
        if self.long_units > 0:
            return "LONG"
        if self.short_units < 0:
            return "SHORT"
        return "FLAT"


# ── Close position request ────────────────────────────────────────────────────

class ClosePositionRequest(BaseModel):
    """
    Sent by the frontend to DELETE /api/positions/{instrument}.
    longUnits / shortUnits can be "ALL" or a specific number.
    """
    long_units:  str = Field(default="ALL", description="'ALL' or a number string")
    short_units: str = Field(default="NONE")