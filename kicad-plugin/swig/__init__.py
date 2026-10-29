try:
    from .noeti_send import NoetiSend
    NoetiSend().register()
except Exception as e:  # a broken plugin must never stop the PCB Editor from starting
    import traceback
    traceback.print_exc()
