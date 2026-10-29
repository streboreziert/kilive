try:
    from .kilive import KiLive
    KiLive().register()
except Exception:  # a broken plugin must never stop the PCB Editor from starting
    import traceback
    traceback.print_exc()
