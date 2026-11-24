<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__) . '/Cabinet.php';

use VashDoctor\ApiError;
use VashDoctor\Cabinet;
use VashDoctor\SmtpSender;

final class TestCabinet extends Cabinet
{
    public int $clock = 1795514400;
    public array $outbox = [];
    public bool $failEmail = false;
    protected function now(): int { return $this->clock; }
    protected function sendCode(string $email, string $code): void
    { if ($this->failEmail) { throw new RuntimeException('Test SMTP refusal'); } $this->outbox[$email] = $code; }
    public function latest(): array { return $this->statement('SELECT * FROM challenges ORDER BY created_at DESC,rowid DESC LIMIT 1')->fetch(); }
    public function accountCount(): int { return (int)$this->statement('SELECT COUNT(*) FROM accounts')->fetchColumn(); }
    public function rawRows(): array
    { return ['accounts' => $this->statement('SELECT * FROM accounts')->fetchAll(), 'children' => $this->statement('SELECT * FROM children')->fetchAll(), 'garden' => $this->statement('SELECT * FROM garden_entries')->fetchAll(), 'challenges' => $this->statement('SELECT * FROM challenges')->fetchAll()]; }
    // A test-only fixture inserts a session; production contains no doctor-login bypass.
    public function doctorFixture(string $id): array
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $this->statement('INSERT INTO sessions(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)', [$this->hash('session:' . $token), $id, $this->clock, $this->clock + 1800]);
        return [$this->authenticate($token), $token];
    }
}
final class CapturedSmtp extends SmtpSender
{
    public array $captured = [];
    public string $message = '';
    public array $result = [true, 250];
    protected function transfer(array $options): array
    { $this->captured = $options; $this->message = stream_get_contents($options[CURLOPT_INFILE]); return $this->result; }
}
$count = 0;
function check(bool $ok, string $label): void
{ global $count; if (!$ok) { throw new RuntimeException('FAIL: ' . $label); } $count++; echo 'PASS ' . $label . PHP_EOL; }
function denied(callable $fn, int $status, string $label, ?string $code = null): void
{
    try { $fn(); }
    catch (ApiError $error) { check($error->status === $status && ($code === null || $error->errorCode === $code), $label); return; }
    throw new RuntimeException('FAIL: no rejection: ' . $label);
}
function throws(callable $fn, string $label): void
{ try { $fn(); } catch (Throwable $error) { check(true, $label); return; } throw new RuntimeException('FAIL: no exception: ' . $label); }
function register(TestCabinet $service, string $email, string $ip, string $name = 'Тестовый Родитель'): array
{
    $challenge = $service->requestCode(['intent' => 'register', 'email' => $email, 'fullName' => $name, 'phone' => '+7 999 123-45-67'], $ip);
    $session = $service->verifyCode($challenge['challengeId'], $service->outbox[$email]);
    return [$service->authenticate($session['token']), $session];
}
function clean(string $path): void
{ foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); } rmdir($path); }

$root = sys_get_temp_dir() . '/vd-email-security-' . bin2hex(random_bytes(8));
mkdir($root, 0700); mkdir($root . '/public', 0700); mkdir($root . '/private', 0700);
$config = ['enabled' => true, 'public_root' => $root . '/public', 'private_dir' => $root . '/private', 'secret' => bin2hex(random_bytes(32)),
    'encryption_key' => base64_encode(random_bytes(32)), 'allowed_origins' => ['https://vash-doc.ru'],
    'smtp_host' => 'smtp.example.org', 'smtp_port' => 465, 'smtp_security' => 'smtps', 'smtp_username' => 'test-user', 'smtp_password' => 'fake-test-password', 'smtp_from' => 'no-reply@example.org'];
try {
    denied(fn() => new Cabinet(array_replace($config, ['enabled' => false])), 503, 'disabled service fails closed');
    denied(fn() => new Cabinet(array_replace($config, ['private_dir' => $root . '/public'])), 503, 'public storage rejected');
    denied(fn() => new Cabinet(array_replace($config, ['allowed_origins' => ['*']])), 503, 'wildcard CORS rejected');
    denied(fn() => new Cabinet(array_replace($config, ['smtp_security' => 'none'])), 503, 'plaintext SMTP rejected');
    denied(fn() => new Cabinet(array_replace($config, ['smtp_host' => 'smtp.example.org/evil'])), 503, 'SMTP URL injection rejected');
    denied(fn() => new Cabinet(array_replace($config, ['smtp_password' => ''])), 503, 'missing SMTP credentials fail closed');
    $service = new TestCabinet($config);
    denied(fn() => $service->requestCode(['intent' => 'register', 'email' => "x@example.org\r\nBcc: y@example.org", 'fullName' => 'Name', 'phone' => '79991234567'], '192.0.2.1'), 422, 'mail header injection rejected');
    denied(fn() => $service->requestCode(['intent' => 'register', 'email' => 'a@example.org', 'fullName' => 'Name', 'phone' => '123'], '192.0.2.1'), 422, 'invalid contact phone rejected');
    denied(fn() => $service->requestCode(['intent' => 'register', 'email' => 'a@example.org', 'fullName' => 'Name', 'phone' => '79991234567', 'role' => 'doctor'], '192.0.2.1'), 422, 'client cannot grant doctor role');
    $challenge = $service->requestCode(['intent' => 'register', 'email' => ' FIRST@EXAMPLE.ORG ', 'fullName' => 'Тестовый Родитель', 'phone' => '89991234567'], '192.0.2.1');
    $correct = $service->outbox['first@example.org'];
    check($service->accountCount() === 0, 'no account before email verification');
    check(!isset($challenge['code']) && !str_contains(json_encode($challenge), $correct), 'OTP absent from public response');
    check($challenge['expiresIn'] === 600 && $challenge['retryAfter'] === 60, 'explicit expiry and resend policy');
    check(!str_contains(json_encode($service->latest()), 'Тестовый') && !str_contains(json_encode($service->latest()), '79991234567') && $service->latest()['code_hash'] !== $correct, 'pending identity encrypted and code hashed');
    denied(fn() => $service->requestCode(['intent' => 'login', 'email' => 'first@example.org'], '192.0.2.1'), 429, 'email resend cooldown');
    $wrong = $correct === '000000' ? '999999' : '000000';
    for ($i = 0; $i < 5; $i++) { denied(fn() => $service->verifyCode($challenge['challengeId'], $wrong), 401, 'wrong attempt ' . ($i + 1) . ' persists'); }
    denied(fn() => $service->verifyCode($challenge['challengeId'], $correct), 401, 'correct code blocked after five failures');
    $service->clock += 61;
    $expired = $service->requestCode(['intent' => 'login', 'email' => 'first@example.org'], '192.0.2.1'); $expiredCode = $service->outbox['first@example.org'];
    $service->clock += 601;
    denied(fn() => $service->verifyCode($expired['challengeId'], $expiredCode), 401, 'expired OTP rejected');
    $service->failEmail = true;
    denied(fn() => $service->requestCode(['intent' => 'login', 'email' => 'first@example.org'], '192.0.2.1'), 503, 'SMTP failure returns real error', 'EMAIL_UNAVAILABLE');
    check($service->latest()['state'] === 'failed', 'failed delivery never activates challenge');
    denied(fn() => $service->verifyCode($service->latest()['id'], '123456'), 401, 'failed challenge cannot authenticate');
    $service->failEmail = false; $service->clock += 61;
    [$parentA, $sessionA] = register($service, 'first@example.org', '192.0.2.1');
    check($sessionA['account']['role'] === 'parent' && $sessionA['account']['phoneVerified'] === false, 'email authenticates parent only, never phone ownership');
    denied(fn() => $service->verifyCode($service->latest()['id'], $service->outbox['first@example.org']), 401, 'OTP cannot be replayed');
    [$parentB, $sessionB] = register($service, 'second@example.org', '192.0.2.2');
    check($parentA['id'] !== $parentB['id'], 'same contact phone does not merge separate email accounts');
    $unknown = $service->requestCode(['intent' => 'login', 'email' => 'unknown@example.org'], '192.0.2.3');
    check(array_keys($unknown) === array_keys($challenge), 'unknown login uses same neutral request-code shape');
    denied(fn() => $service->verifyCode($unknown['challengeId'], $service->outbox['unknown@example.org']), 409, 'unknown account registration requirement only after verified email', 'REGISTRATION_REQUIRED');
    $childA = $service->createChild($parentA, ['name' => 'Тестовый ребёнок А', 'birthDate' => '2020-04-18', 'relationship' => 'mother'])['child'];
    $childB = $service->createChild($parentB, ['name' => 'Тестовый ребёнок Б', 'relationship' => 'father'])['child'];
    check($childB['birthDate'] === '' && $childA['linkStatus'] === 'unverified', 'optional birth date and no automatic medical linkage');
    check($childA['doctorIds'] === [] && $childA['doctorAssignment']['status'] === 'unassigned', 'new child has explicit unassigned doctor metadata');
    denied(fn() => $service->garden($parentB, $childA['id'], '2026-11'), 404, 'other parent cannot read child diary');
    denied(fn() => $service->saveGarden($parentB, $childA['id'], ['date' => '2026-11-21', 'entry' => ['water' => 'done']]), 404, 'other parent cannot write child diary');
    denied(fn() => $service->saveGarden($parentA, $childA['id'], ['date' => '2019-01-01', 'entry' => ['water' => 'done']]), 422, 'diary before birth rejected');
    denied(fn() => $service->saveGarden($parentA, $childA['id'], ['date' => '2099-01-01', 'entry' => ['water' => 'done']]), 422, 'future day rejected');
    $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-21', 'entry' => ['meal' => 'done', 'note' => 'Личная тестовая заметка']]);
    $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-22', 'entry' => ['water' => 'partial']]);
    $garden = $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-21', 'entry' => ['sleep' => 'missed']])['garden'];
    check($garden['entries']['2026-11-21']['meal'] === 'done' && $garden['entries']['2026-11-21']['sleep'] === 'missed' && $garden['entries']['2026-11-22']['water'] === 'partial', 'partial updates preserve other marks and days');
    $garden = $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-21', 'entry' => ['sleep' => null, 'note' => '']])['garden'];
    check(!isset($garden['entries']['2026-11-21']['sleep']) && !isset($garden['entries']['2026-11-21']['note']), 'unmark remains absence, not missed');
    denied(fn() => $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-21', 'entry' => ['water' => 'doctor']]), 422, 'unknown diary value rejected');
    denied(fn() => $service->saveGarden($parentA, $childA['id'], ['date' => '2026-11-21', 'entry' => ['note' => str_repeat('я', 1201)]]), 422, 'note length enforced');
    $doctorId = $service->provisionDoctor('Демо Врач', '79990001122')['doctorId'];
    $otherDoctorId = $service->provisionDoctor('Другой Врач', '79990003344')['doctorId'];
    [$doctor, $doctorToken] = $service->doctorFixture($doctorId); [$otherDoctor] = $service->doctorFixture($otherDoctorId);
    check($service->doctorChildren($doctor)['children'] === [], 'unassigned doctor has no patients');
    denied(fn() => $service->doctorChildren($parentA), 403, 'parent token cannot use doctor route');
    $service->assignDoctor($doctorId, $childA['id'], 'Test clinic operator approved assignment.');
    $assignedView = $service->me($parentA)['children'][0];
    check($assignedView['doctorIds'] === [$doctorId] && $assignedView['doctorAssignment']['status'] === 'assigned' && $assignedView['doctorAssignment']['doctors'][0]['displayName'] === 'Демо Врач', 'parent sees clinic-assigned doctor metadata');
    check(count($service->doctorChildren($doctor)['children']) === 1 && $service->doctorChildren($doctor)['children'][0]['id'] === $childA['id'], 'doctor list contains only assigned child');
    denied(fn() => $service->doctorGarden($doctor, $childB['id'], '2026-11'), 404, 'child ID substitution cannot bypass assignment');
    denied(fn() => $service->doctorGarden($otherDoctor, $childA['id'], '2026-11'), 404, 'second doctor cannot read assigned child');
    check($service->doctorGarden($doctor, $childA['id'], '2026-11')['garden']['entries']['2026-11-22']['water'] === 'partial', 'assigned doctor sees parent daily marks');
    denied(fn() => $service->saveGarden($doctor, $childA['id'], ['date' => '2026-11-21', 'entry' => ['water' => 'done']]), 403, 'doctor cannot rewrite family marks');
    $service->doctorRecommendations($doctor, $childA['id'], ['recommendations' => ['water' => 'Индивидуальная тестовая рекомендация']]);
    check($service->garden($parentA, $childA['id'], '2026-11')['garden']['recommendations']->water === 'Индивидуальная тестовая рекомендация', 'doctor plan reaches matching family');
    denied(fn() => $service->doctorRecommendations($otherDoctor, $childA['id'], ['recommendations' => ['water' => 'wrong']]), 404, 'unassigned doctor cannot alter plan');
    $service->unassignDoctor($doctorId, $childA['id']);
    denied(fn() => $service->authenticate($doctorToken), 401, 'unassign revokes doctor sessions');
    denied(fn() => $service->doctorGarden($doctor, $childA['id'], '2026-11'), 404, 'assignment checked on every access');
    check($service->documents($parentA, $childA['id'])['documents'] === [], 'medical documents remain disconnected');
    $raw = json_encode($service->rawRows(), JSON_UNESCAPED_UNICODE);
    check(!str_contains($raw, 'Тестовый Родитель') && !str_contains($raw, 'Тестовый ребёнок') && !str_contains($raw, 'first@example.org') && !str_contains($raw, '79991234567'), 'identity and diary content not stored in plaintext');
    $service->logout($sessionA['token'], $parentA);
    denied(fn() => $service->authenticate($sessionA['token']), 401, 'logout revokes session');
    $service->clock += 3601;
    [$sameParent, $newSession] = register($service, 'first@example.org', '192.0.2.1', 'Attempted replacement name');
    check($sameParent['id'] === $parentA['id'] && $newSession['account']['displayName'] === 'Тестовый Родитель' && count($newSession['children']) === 1, 'existing verified mailbox retains original profile and children');
    $service->clock += 1801;
    denied(fn() => $service->authenticate($newSession['token']), 401, 'bearer expires after 30 minutes');
    $service->clock += 3601;
    $old = $service->requestCode(['intent' => 'login', 'email' => 'second@example.org'], '192.0.2.2'); $oldCode = $service->outbox['second@example.org'];
    $service->clock += 61;
    $new = $service->requestCode(['intent' => 'login', 'email' => 'second@example.org'], '192.0.2.2');
    denied(fn() => $service->verifyCode($old['challengeId'], $oldCode), 401, 'resend invalidates prior challenge');
    check(isset($service->verifyCode($new['challengeId'], $service->outbox['second@example.org'])['token']), 'latest code remains valid');
    $smtp = new CapturedSmtp(); $smtp->send($config, 'recipient@example.org', '123456');
    check($smtp->captured[CURLOPT_USE_SSL] === CURLUSESSL_ALL && $smtp->captured[CURLOPT_SSL_VERIFYPEER] === true && $smtp->captured[CURLOPT_SSL_VERIFYHOST] === 2, 'real SMTP transport requires validated TLS');
    check($smtp->captured[CURLOPT_MAIL_RCPT] === ['<recipient@example.org>'] && str_contains($smtp->message, 'Content-Transfer-Encoding: base64'), 'mail has exactly one validated recipient and encoded content');
    $smtp->result = [false, 0]; throws(fn() => $smtp->send($config, 'recipient@example.org', '123456'), 'transport failure is not success');
    $smtp->result = [true, 550]; throws(fn() => $smtp->send($config, 'recipient@example.org', '123456'), 'SMTP rejection is not success');
    throws(fn() => $smtp->send($config, "recipient@example.org\r\nBcc: thief@example.org", '123456'), 'transport also rejects recipient injection');
    throws(fn() => new Cabinet(array_replace($config, ['encryption_key' => base64_encode(random_bytes(32))])), 'changed encryption key fails without creating fresh account store');
    echo PHP_EOL . $count . ' checks passed; all messages captured in test doubles, no network sends.' . PHP_EOL;
} finally { unset($service); clean($root); }
