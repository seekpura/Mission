from pathlib import Path

path = Path("src/runtime/bootstrap.ts")
text = path.read_text(encoding="utf-8")
old = '''    close(): void {
      if (closed) return;
      shutdownStarted = true;
      if (recoveryPromise) throw new Error("Cannot synchronously close Mission Runtime while startup recovery is active");
'''
new = '''    close(): void {
      if (closed) return;
      if (shutdownPromise) throw new Error("Cannot synchronously close Mission Runtime while asynchronous shutdown is in progress");
      shutdownStarted = true;
      if (recoveryPromise) throw new Error("Cannot synchronously close Mission Runtime while startup recovery is active");
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one runtime close guard anchor, got {text.count(old)}")
path.write_text(text.replace(old, new), encoding="utf-8")
