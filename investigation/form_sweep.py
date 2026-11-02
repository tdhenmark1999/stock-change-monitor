"""Drives the real changedetection.io edit form from inside the container.

  form_sweep.py save <uuid>   submit the form with a sentinel in every field
  form_sweep.py check <uuid>  compare the sentinels with watch.json on disk

Run with: docker exec -i <container> python3 - save <uuid> < form_sweep.py
"""
import json
import sys

import requests
from bs4 import BeautifulSoup

BASE = "http://127.0.0.1:5000"

# Form field -> value submitted. Each one is a thing a user would "add" in the UI.
SENTINELS = {
    "title": "sweep-title",
    "include_filters": "h1\n.price",
    "subtractive_selectors": ".ads",
    "extract_text": "CHF [0-9.]+",
    "ignore_text": "ignored-sentinel",
    "trigger_text": "trigger-sentinel",
    "text_should_not_be_present": "out of stock",
    "headers": "X-Sweep: 1",
    "notification_title": "sweep-notification-title",
    "notification_body": "sweep-notification-body",
    "notification_urls": "json://example.com/hook",
    "time_between_check-hours": "6",
}

# watch.json key -> how to read the stored value back for comparison.
EXPECTED = {
    "title": lambda w: w.get("title") == "sweep-title",
    "include_filters": lambda w: w.get("include_filters") == ["h1", ".price"],
    "subtractive_selectors": lambda w: w.get("subtractive_selectors") == [".ads"],
    "extract_text": lambda w: w.get("extract_text") == ["CHF [0-9.]+"],
    "ignore_text": lambda w: w.get("ignore_text") == ["ignored-sentinel"],
    "trigger_text": lambda w: w.get("trigger_text") == ["trigger-sentinel"],
    "text_should_not_be_present": lambda w: w.get("text_should_not_be_present") == ["out of stock"],
    "headers": lambda w: w.get("headers") == {"X-Sweep": "1"},
    "notification_title": lambda w: w.get("notification_title") == "sweep-notification-title",
    "notification_body": lambda w: w.get("notification_body") == "sweep-notification-body",
    "notification_urls": lambda w: w.get("notification_urls") == ["json://example.com/hook"],
    "time_between_check": lambda w: w.get("time_between_check", {}).get("hours") == 6,
    "time_between_check_use_default": lambda w: w.get("time_between_check_use_default") is False,
}


def save(uuid):
    session = requests.Session()
    page = session.get(f"{BASE}/edit/{uuid}")
    form = BeautifulSoup(page.text, "lxml").find(
        lambda t: t.name == "form" and t.find(attrs={"name": "include_filters"})
    )
    data = {}
    for el in form.find_all(["input", "textarea", "select"]):
        name = el.get("name")
        if not name:
            continue
        if el.name == "textarea":
            data[name] = el.text.strip()
        elif el.name == "select":
            chosen = el.find("option", selected=True) or el.find("option")
            data[name] = chosen.get("value") if chosen else ""
        elif el.get("type") in ("checkbox", "radio"):
            if el.has_attr("checked"):
                data[name] = el.get("value", "y")
        elif el.get("type") != "submit":
            data[name] = el.get("value", "")
    data.update(SENTINELS)
    data.pop("time_between_check_use_default", None)
    data["save_button"] = "Save"

    res = session.post(f"{BASE}/edit/{uuid}", data=data, allow_redirects=True)
    soup = BeautifulSoup(res.text, "lxml")
    flashes = [m.get_text(strip=True) for m in soup.select(".messages li, ul.messages li")]
    errors = [e.get_text(" ", strip=True) for e in soup.select("ul.errors")]
    print(f"  form POST: http {res.status_code} flash={flashes} errors={errors}")


def check(uuid):
    with open(f"/datastore/{uuid}/watch.json") as fh:
        watch = json.load(fh)
    lost = [k for k, ok in EXPECTED.items() if not ok(watch)]
    print(f"  fields ok: {len(EXPECTED) - len(lost)}/{len(EXPECTED)}" + (f"  LOST={lost}" if lost else ""))


{"save": save, "check": check}[sys.argv[1]](sys.argv[2])
