"""Exercise the real PHP router on loopback. No real SMTP, SMS, or patient data.

Usage: python3 tests/http_security.py php [php runtime arguments...]
The generated test-only router simulates a web server's HTTPS flag. Production
has no HTTP/TLS bypass or test flag; never install this test directory.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


SOURCE = Path(__file__).resolve().parents[1]
PHP = sys.argv[1:] or ["php"]
checks = 0


def check(condition: bool, label: str) -> None:
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1
    print("PASS", label)


with tempfile.TemporaryDirectory(prefix="vd-email-http-") as temp:
    root = Path(temp)
    public = root / "public"
    private = root / "private"
    public.mkdir(mode=0o700)
    private.mkdir(mode=0o700)
    for name in ("Cabinet.php", "SmtpSender.php", "patient-cabinet.php"):
        shutil.copy2(SOURCE / name, public / name)
    config_path = root / "config.php"
    config_path.write_text("<?php return [\n" +
        "'enabled'=>true,'public_root'=>" + json.dumps(str(public)) + ",\n" +
        "'private_dir'=>" + json.dumps(str(private)) + ",\n" +
        "'secret'=>'" + os.urandom(32).hex() + "',\n" +
        "'encryption_key'=>base64_encode(hex2bin('" + os.urandom(32).hex() + "')),\n" +
        "'allowed_origins'=>['https://app.example.org'],\n" +
        "'smtp_host'=>'smtp.example.org','smtp_port'=>465,'smtp_security'=>'smtps',\n" +
        "'smtp_username'=>'test','smtp_password'=>'fake-test-only','smtp_from'=>'test@example.org'];\n")
    config_path.chmod(0o600)
    environment = {**os.environ, "VD_CABINET_CONFIG": str(config_path)}
    seed = root / "seed.php"
    seed.write_text("<?php\nrequire " + json.dumps(str(public / "Cabinet.php")) + ";\n" + r"""
class TestSeed extends VashDoctor\Cabinet {
    public string $sentCode = '';
    protected function sendCode(string $email,string $code): void { $this->sentCode = $code; }
}
$service=new TestSeed(require getenv('VD_CABINET_CONFIG'));
$a=$service->requestCode(['intent'=>'register','email'=>'parent-a@example.org','fullName'=>'Test Parent A','phone'=>'79991234567'],'192.0.2.1');
$sessionA=$service->verifyCode($a['challengeId'],$service->sentCode);
$accountA=$service->authenticate($sessionA['token']);
$childA=$service->createChild($accountA,['name'=>'Test Child A','relationship'=>'mother'])['child'];
$b=$service->requestCode(['intent'=>'register','email'=>'parent-b@example.org','fullName'=>'Test Parent B','phone'=>'79997654321'],'192.0.2.2');
$sessionB=$service->verifyCode($b['challengeId'],$service->sentCode);
$childB=$service->createChild($service->authenticate($sessionB['token']),['name'=>'Test Child B','relationship'=>'father'])['child'];
echo json_encode(['token'=>$sessionA['token'],'ownChild'=>$childA['id'],'otherChild'=>$childB['id'],'today'=>date('Y-m-d')]);
""")
    fixture = json.loads(subprocess.check_output([*PHP, str(seed)], env=environment, text=True))
    router = root / "router.php"
    router.write_text("<?php\n" +
        "$_SERVER['HTTPS']=isset($_GET['test_plain'])?'off':'on';\n" +
        "if(isset($_GET['test_missing']))putenv('VD_CABINET_CONFIG');\n" +
        "require " + json.dumps(str(public / "patient-cabinet.php")) + ";\n")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with open(root / "server.log", "wb") as log:
        process = subprocess.Popen([*PHP, "-S", f"127.0.0.1:{port}", "-t", str(public), str(router)], env=environment, stdout=log, stderr=log)
        base = f"http://127.0.0.1:{port}/patient-cabinet.php?action="

        def request(action: str, method: str = "GET", body=None, token=None, origin="https://app.example.org", raw=None, content_type="application/json", extra=None):
            headers = {"Origin": origin}
            if token:
                headers["Authorization"] = "Bearer " + token
            if body is not None or raw is not None:
                headers["Content-Type"] = content_type
            if extra:
                headers.update(extra)
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            req = urllib.request.Request(base + action, data=data, method=method, headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            payload = response.read()
            return response.status, response.headers, json.loads(payload) if payload else {}

        try:
            for _ in range(50):
                try:
                    status, headers, data = request("health")
                    break
                except urllib.error.URLError:
                    if process.poll() is not None:
                        raise RuntimeError("PHP test server did not start")
                    time.sleep(0.05)
            else:
                raise RuntimeError("PHP test server startup timed out")
            check(status == 200 and data["ready"] is True and data["apiVersion"] == 2 and data["auth"]["doctor"] == "unavailable", "health advertises email API and disabled doctor SMS")
            check("no-store" in headers["Cache-Control"] and headers["Access-Control-Allow-Origin"] == "https://app.example.org", "responses are not cached and CORS is exact")
            check(request("health", origin="https://attacker.example.org")[0] == 403, "foreign origin denied")
            check(request("health&test_plain=1", extra={"X-Forwarded-Proto": "https"})[0] == 400, "client forwarded header cannot bypass HTTPS")
            check(request("health&test_missing=1")[2]["ready"] is False, "missing configuration reports not ready")
            check(request("me")[0] == 401, "private account requires bearer")
            check(request("me", token=fixture["token"])[2]["account"]["role"] == "parent", "real bearer authenticates matching parent")
            check(request("request-code", "POST", raw=b"[]")[0] == 400, "JSON array is not a request object")
            check(request("request-code", "POST", raw=b"{")[0] == 400, "malformed JSON rejected")
            check(request("request-code", "POST", body={}, content_type="text/plain")[0] == 415, "non-JSON request rejected")
            check(request("request-code", "POST", raw=b"x" * 16385)[0] == 413, "oversize body rejected")
            check(request("request-code", "POST", body={"email": "bad", "intent": "login"})[0] == 422, "invalid email never reaches SMTP")
            check(request("request-code", "GET")[0] == 405, "wrong authentication method rejected")
            check(request("verify-code", "POST", body={"challengeId": "0" * 32, "code": "123456"})[0] == 401, "unknown OTP challenge rejected")
            check(request("request-doctor-code", "POST", body={})[2]["error"]["code"] == "DOCTOR_AUTH_UNAVAILABLE", "doctor SMS cannot be enabled by browser")
            check(request("doctor-children", token=fixture["token"])[0] == 403, "parent bearer cannot read doctor list")
            check(request("garden&childId=" + fixture["otherChild"], token=fixture["token"])[0] == 404, "router enforces family ownership")
            check(request("garden&childId=" + fixture["ownChild"], token=fixture["token"])[2]["garden"]["entries"] == {}, "empty diary serializes as JSON object")
            save = request("garden&childId=" + fixture["ownChild"], "PUT", body={"date": fixture["today"], "entry": {"water": "done"}}, token=fixture["token"])
            check(save[0] == 200 and save[2]["garden"]["entries"][fixture["today"]]["water"] == "done", "actual HTTP diary save persists")
            check(request("documents&childId=" + fixture["ownChild"], token=fixture["token"])[2]["documents"] == [], "documents stay disconnected")
            check(request("assign-doctor", "POST", body={}, token=fixture["token"])[0] == 404, "operator assignment has no web route")
            check(request("logout", "POST", body={}, token=fixture["token"])[0] == 200, "logout succeeds over real router")
            check(request("me", token=fixture["token"])[0] == 401, "revoked bearer cannot be reused")
            print(f"\n{checks} HTTP checks passed. No real SMTP or SMS sends.")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
