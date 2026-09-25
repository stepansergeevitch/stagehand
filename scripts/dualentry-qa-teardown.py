"""Delete every QA record whose key starts with a prefix, dependents first.

Run from backend/ inside a task worktree:
    QA_PREFIX=QA-INV-135 poetry run python dualentry/manage.py shell < /Users/stepanburlakov/code/my/stagehand/scripts/dualentry-qa-teardown.py

Deletes, with all rows that point at them (PROTECT included): items by sku, serial numbers by value, customers,
vendors and locations by name, and the inventory, sales and purchase documents whose memo starts with the prefix.
Prints one line per model deleted. QA_DRY_RUN=1 prints what it would delete and rolls back.
"""

import os
import sys
from collections import Counter

from django.db import transaction
from django.db.models import Model

PREFIX = os.environ.get("QA_PREFIX", "").strip()
DRY = os.environ.get("QA_DRY_RUN", "") == "1"
if not PREFIX:
    sys.exit("QA_PREFIX is not set")


def load(path):
    module, name = path.rsplit(".", 1)
    try:
        return getattr(__import__(module, fromlist=[name]), name)
    except Exception:
        return None


ROOTS = [
    ("core.models.item.Item", "sku"),
    ("inventory.models.SerialNumber", "value"),
    ("core.models.customer.Customer", "name"),
    ("core.models.vendor.Vendor", "name"),
    ("inventory.models.Location", "name"),
    ("inventory.models.InventoryReceipt", "memo"),
    ("inventory.models.InventoryFulfillment", "memo"),
    ("inventory.models.InventoryAdjustment", "memo"),
    ("inventory.models.InventoryTransfer", "memo"),
    ("core.models.records.invoice.Invoice", "memo"),
    ("core.models.records.cash_sale.CashSale", "memo"),
    ("core.models.records.sales_order.SalesOrder", "memo"),
    ("core.models.records.purchase_order.PurchaseOrder", "memo"),
    ("core.models.records.bill.Bill", "memo"),
]

deleted = Counter()
seen = set()


def purge(obj: Model) -> None:
    key = (obj._meta.label, obj.pk)
    if key in seen:
        return
    seen.add(key)
    for rel in obj._meta.get_fields():
        if not (rel.auto_created and not rel.concrete):
            continue
        accessor = rel.get_accessor_name()
        if accessor is None:
            continue
        if rel.one_to_one:
            try:
                child = getattr(obj, accessor)
            except Exception:
                child = None
            children = [child] if child is not None else []
        else:
            try:
                children = list(getattr(obj, accessor).all())
            except Exception:
                children = []
        for child in children:
            purge(child)
    deleted[obj._meta.label] += 1
    if not DRY:
        obj.delete()


with transaction.atomic():
    for path, field in ROOTS:
        model = load(path)
        if model is None or not any(f.name == field for f in model._meta.get_fields()):
            continue
        for obj in list(model.objects.filter(**{f"{field}__startswith": PREFIX})):
            purge(obj)
    if DRY:
        transaction.set_rollback(True)

for label, n in sorted(deleted.items()):
    print(f"{'would delete' if DRY else 'deleted'} {label}: {n}")
print(f"teardown {'dry run' if DRY else 'done'} for prefix {PREFIX!r}: {sum(deleted.values())} rows")
