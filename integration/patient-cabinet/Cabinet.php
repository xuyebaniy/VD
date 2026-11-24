<?php
declare(strict_types=1);

namespace VashDoctor;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use RuntimeException;
use Throwable;

require_once __DIR__ . '/SmtpSender.php';

final class ApiError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message, public readonly int $retryAfter = 0)
    { parent::__construct($message); }
}

/** API v2. Email verifies the parent's mailbox only; it does not verify phone or legal identity. */
class Cabinet
{
    protected PDO $db;
    protected array $config;
    private string $key;
    private DateTimeZone $timezone;
    private const MARKS = ['meal', 'water', 'activity', 'sleep', 'screen', 'mood'];
    private const RELATIONS = ['mother', 'father', 'grandmother', 'grandfather', 'guardian'];

    public function __construct(array $config)
    {
        $this->config = $config;
        $this->validateConfig();
        $this->key = base64_decode($this->config['encryption_key'], true);
        $this->timezone = new DateTimeZone('Europe/Moscow');
        umask(0077);
        $path = $this->config['private_dir'] . '/cabinet-v2.sqlite';
        foreach ([$path, $path . '-wal', $path . '-shm'] as $file) {
            if (is_link($file) || (file_exists($file) && (!is_file($file) || ((int)fileperms($file) & 0077) !== 0))) {
                throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Личный кабинет временно недоступен.');
            }
        }
        if (is_file($this->config['private_dir'] . '/cabinet.sqlite')) {
            throw new ApiError(503, 'MIGRATION_REQUIRED', 'Для подключения кабинета требуется обновление хранилища.');
        }
        $this->db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->db->exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
        $this->db->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('parent','doctor')), email_key TEXT UNIQUE, email_enc TEXT, phone_enc TEXT NOT NULL, name_enc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, email_key TEXT NOT NULL, email_enc TEXT NOT NULL, pending_enc TEXT NOT NULL, ip_key TEXT NOT NULL, code_hash TEXT NOT NULL, intent TEXT NOT NULL CHECK(intent IN ('register','login')), state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS challenges_email_time ON challenges(email_key,created_at);
CREATE INDEX IF NOT EXISTS challenges_ip_time ON challenges(ip_key,created_at);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, name_enc TEXT NOT NULL, birth_enc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (account_id TEXT NOT NULL REFERENCES accounts(id), child_id TEXT NOT NULL REFERENCES children(id), relationship TEXT NOT NULL, PRIMARY KEY(account_id,child_id));
CREATE TABLE IF NOT EXISTS garden_entries (child_id TEXT NOT NULL REFERENCES children(id), entry_date TEXT NOT NULL, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(child_id,entry_date));
CREATE TABLE IF NOT EXISTS doctor_assignments (doctor_id TEXT NOT NULL REFERENCES accounts(id), child_id TEXT NOT NULL REFERENCES children(id), evidence_enc TEXT NOT NULL, assigned_at INTEGER NOT NULL, PRIMARY KEY(doctor_id,child_id));
CREATE TABLE IF NOT EXISTS recommendations (child_id TEXT PRIMARY KEY REFERENCES children(id), data_enc TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES accounts(id), updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, account_id TEXT, child_id TEXT, created_at INTEGER NOT NULL);
SQL);
        $this->transaction(function (): void {
            $check = $this->statement("SELECT value FROM metadata WHERE name='key_check'")->fetchColumn();
            $expected = 'vd-cabinet-v2:' . $this->hash('database-key-check');
            if ($check === false) {
                $this->statement("INSERT INTO metadata(name,value) VALUES('key_check',?)", [$this->encrypt($expected)]);
            } elseif (!hash_equals($expected, $this->decrypt((string)$check))) {
                throw new ApiError(503, 'KEY_MISMATCH', 'Личный кабинет временно недоступен.');
            }
        });
    }

    private function validateConfig(): void
    {
        $c = $this->config;
        $key = is_string($c['encryption_key'] ?? null) ? base64_decode($c['encryption_key'], true) : false;
        $private = realpath((string)($c['private_dir'] ?? ''));
        $public = realpath((string)($c['public_root'] ?? ''));
        $secret = (string)($c['secret'] ?? '');
        $host = (string)($c['smtp_host'] ?? '');
        $user = (string)($c['smtp_username'] ?? '');
        $password = (string)($c['smtp_password'] ?? '');
        $from = (string)($c['smtp_from'] ?? '');
        if (($c['enabled'] ?? false) !== true || !preg_match('/^[a-fA-F0-9]{64,128}$/D', $secret) || $key === false || strlen($key) !== 32 ||
            !$private || !$public || !is_dir($private) || !is_dir($public) || $private === $public || str_starts_with($private . '/', rtrim($public, '/') . '/') ||
            !is_writable($private) || ((int)fileperms($private) & 0077) !== 0 ||
            !preg_match('/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/D', $host) || str_ends_with($host, '.invalid') ||
            !is_int($c['smtp_port'] ?? null) || $c['smtp_port'] < 1 || $c['smtp_port'] > 65535 ||
            !in_array($c['smtp_security'] ?? '', ['smtps', 'starttls'], true) || $user === '' || $password === '' ||
            preg_match('/[\r\n\x00]/', $user . $password . $from) || preg_match('/REPLACE|PASTE|YOUR_/i', $user . $password) ||
            !filter_var($from, FILTER_VALIDATE_EMAIL) || str_ends_with($from, '.invalid') ||
            !extension_loaded('pdo_sqlite') || !extension_loaded('openssl') || !function_exists('curl_init') ||
            !in_array('smtp', curl_version()['protocols'] ?? [], true) || !in_array('smtps', curl_version()['protocols'] ?? [], true)) {
            throw new ApiError(503, 'NOT_CONFIGURED', 'Вход по почте пока не подключён.');
        }
        if (!is_array($c['allowed_origins'] ?? null) || !$c['allowed_origins']) { throw new ApiError(503, 'NOT_CONFIGURED', 'Вход по почте пока не подключён.'); }
        foreach ($c['allowed_origins'] as $origin) {
            if (!is_string($origin) || !preg_match('~^https://[a-z0-9.-]+(?::[0-9]{2,5})?$~D', $origin)) {
                throw new ApiError(503, 'NOT_CONFIGURED', 'Вход по почте пока не подключён.');
            }
        }
        $this->config['private_dir'] = $private;
        $this->config['public_root'] = $public;
    }

    protected function now(): int { return time(); }
    private function iso(int $time): string { return gmdate('Y-m-d\TH:i:s\Z', $time); }
    private function today(): string { return (new DateTimeImmutable('@' . $this->now()))->setTimezone($this->timezone)->format('Y-m-d'); }
    private function id(): string { return bin2hex(random_bytes(16)); }
    protected function hash(string $value): string { return hash_hmac('sha256', $value, $this->config['secret']); }

    protected function encrypt(string $plain): string
    {
        $nonce = random_bytes(12); $tag = '';
        $cipher = openssl_encrypt($plain, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $nonce, $tag, 'vd-cabinet-v2', 16);
        if ($cipher === false) { throw new RuntimeException('Encryption failed'); }
        return base64_encode($nonce . $tag . $cipher);
    }
    protected function decrypt(string $packed): string
    {
        $raw = base64_decode($packed, true);
        if ($raw === false || strlen($raw) < 28) { throw new RuntimeException('Invalid encrypted record'); }
        $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), 'vd-cabinet-v2');
        if ($plain === false) { throw new RuntimeException('Encrypted record authentication failed'); }
        return $plain;
    }
    protected function statement(string $sql, array $params = []): \PDOStatement
    { $statement = $this->db->prepare($sql); $statement->execute($params); return $statement; }
    private function transaction(callable $operation): mixed
    {
        $this->db->exec('BEGIN IMMEDIATE');
        try { $result = $operation(); $this->db->exec('COMMIT'); return $result; }
        catch (Throwable $error) { $this->db->exec('ROLLBACK'); throw $error; }
    }
    private function fields(array $input, array $allowed): void
    { foreach (array_keys($input) as $field) if (!in_array($field, $allowed, true)) { throw new ApiError(422, 'INVALID_FIELD', 'Запрос содержит неизвестное поле.'); } }
    public function normalizeEmail(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 254 || preg_match('/[\r\n<>\x00]/', $value)) { throw new ApiError(422, 'INVALID_EMAIL', 'Укажите адрес электронной почты.'); }
        $value = strtolower(trim($value));
        if (!filter_var($value, FILTER_VALIDATE_EMAIL)) { throw new ApiError(422, 'INVALID_EMAIL', 'Укажите адрес электронной почты.'); }
        return $value;
    }
    private function phone(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 32 || preg_match('/[^0-9+()\s-]/', $value)) { throw new ApiError(422, 'INVALID_PHONE', 'Укажите номер телефона.'); }
        $phone = preg_replace('/\D/', '', $value);
        if (strlen($phone) === 11 && $phone[0] === '8') { $phone = '7' . substr($phone, 1); }
        if (!preg_match('/^79[0-9]{9}$/D', $phone)) { throw new ApiError(422, 'INVALID_PHONE', 'Укажите российский мобильный номер +7 9XX XXX-XX-XX.'); }
        return $phone;
    }
    private function text(mixed $value, int $max, bool $empty = false, bool $multiline = false): string
    {
        if (!is_string($value) || !preg_match('//u', $value) || preg_match($multiline ? '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u', $value)) { throw new ApiError(422, 'INVALID_FIELD', 'Проверьте введённые данные.'); }
        $value = trim($value); $length = preg_match_all('/./us', $value);
        if ((!$empty && $value === '') || $length === false || $length > $max) { throw new ApiError(422, 'INVALID_FIELD', 'Проверьте длину введённых данных.'); }
        return $value;
    }
    private function maskedEmail(string $email): string
    { [$local, $domain] = explode('@', $email, 2); return substr($local, 0, 1) . '•••@' . $domain; }

    public function requestCode(array $input, string $ip): array
    {
        $this->fields($input, ['email', 'intent', 'fullName', 'phone']);
        $email = $this->normalizeEmail($input['email'] ?? null);
        $intent = $input['intent'] ?? null;
        if (!in_array($intent, ['register', 'login'], true)) { throw new ApiError(422, 'INVALID_INTENT', 'Выберите вход или регистрацию.'); }
        $pending = $intent === 'register' ? ['fullName' => $this->text($input['fullName'] ?? null, 150), 'phone' => $this->phone($input['phone'] ?? null)] : [];
        $emailKey = $this->hash('email:' . $email); $ipKey = $this->hash('ip:' . $ip);
        $now = $this->now(); $challenge = $this->id(); $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $this->transaction(function () use ($email, $emailKey, $ipKey, $now, $challenge, $code, $intent, $pending): void {
            $latest = $this->statement('SELECT MAX(created_at) FROM challenges WHERE email_key=?', [$emailKey])->fetchColumn();
            if ($latest !== false && $latest !== null && $now - (int)$latest < 60) { throw new ApiError(429, 'RETRY_LATER', 'Повторный код можно запросить через минуту.', 60 - ($now - (int)$latest)); }
            $limits = [
                [(int)$this->statement('SELECT COUNT(*) FROM challenges WHERE email_key=? AND created_at>?', [$emailKey, $now - 3600])->fetchColumn(), 5],
                [(int)$this->statement('SELECT COUNT(*) FROM challenges WHERE email_key=? AND created_at>?', [$emailKey, $now - 86400])->fetchColumn(), 10],
                [(int)$this->statement('SELECT COUNT(*) FROM challenges WHERE ip_key=? AND created_at>?', [$ipKey, $now - 3600])->fetchColumn(), 20],
                [(int)$this->statement('SELECT COUNT(*) FROM challenges WHERE created_at>?', [$now - 3600])->fetchColumn(), max(1, min(1000, (int)($this->config['email_hour_limit'] ?? 100)))],
                [(int)$this->statement('SELECT COUNT(*) FROM challenges WHERE created_at>?', [$now - 86400])->fetchColumn(), max(1, min(5000, (int)($this->config['email_day_limit'] ?? 300)))],
            ];
            foreach ($limits as [$count, $limit]) if ($count >= $limit) { throw new ApiError(429, 'RATE_LIMITED', 'Слишком много запросов. Попробуйте позже.', 3600); }
            $this->statement("UPDATE challenges SET state='superseded' WHERE email_key=? AND state IN ('pending','accepted')", [$emailKey]);
            $this->statement('INSERT INTO challenges(id,email_key,email_enc,pending_enc,ip_key,code_hash,intent,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [
                $challenge, $emailKey, $this->encrypt($email), $this->encrypt(json_encode($pending, JSON_THROW_ON_ERROR)), $ipKey,
                $this->hash('otp:' . $challenge . ':' . $code), $intent, 'pending', $now, $now + 600,
            ]);
            $this->statement('DELETE FROM challenges WHERE created_at<?', [$now - 172800]);
            $this->statement('DELETE FROM sessions WHERE expires_at<=?', [$now]);
        });
        // Same dispatch and public response for known and unknown mailboxes; no account enumeration before OTP.
        try {
            $this->sendCode($email, $code);
            $updated = $this->statement("UPDATE challenges SET state='accepted' WHERE id=? AND state='pending' AND expires_at>?", [$challenge, $this->now()])->rowCount();
            if ($updated !== 1) { throw new RuntimeException('Challenge expired or superseded'); }
        } catch (Throwable $error) {
            $this->statement("UPDATE challenges SET state='failed' WHERE id=? AND state='pending'", [$challenge]);
            throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'Не удалось отправить код на почту. Попробуйте позже.');
        }
        return ['challengeId' => $challenge, 'expiresIn' => max(0, $now + 600 - $this->now()), 'retryAfter' => 60, 'emailMasked' => $this->maskedEmail($email)];
    }
    protected function sendCode(string $email, string $code): void { (new SmtpSender())->send($this->config, $email, $code); }

    public function verifyCode(mixed $challengeId, mixed $code): array
    {
        if (!is_string($challengeId) || !preg_match('/^[a-f0-9]{32}$/D', $challengeId) || !is_string($code) || !preg_match('/^[0-9]{6}$/D', $code)) { throw new ApiError(422, 'INVALID_CODE', 'Введите шестизначный код из письма.'); }
        $result = $this->transaction(function () use ($challengeId, $code): array {
            $now = $this->now(); $challenge = $this->statement('SELECT * FROM challenges WHERE id=?', [$challengeId])->fetch();
            if (!$challenge || $challenge['state'] !== 'accepted' || (int)$challenge['expires_at'] <= $now || (int)$challenge['attempts'] >= 5) { return ['failure' => new ApiError(401, 'CODE_EXPIRED', 'Код недействителен или истёк. Запросите новый.')]; }
            if (!hash_equals($challenge['code_hash'], $this->hash('otp:' . $challengeId . ':' . $code))) {
                $this->statement('UPDATE challenges SET attempts=attempts+1 WHERE id=?', [$challengeId]);
                return ['failure' => new ApiError(401, 'INVALID_CODE', 'Код не подошёл. Проверьте письмо.')];
            }
            $this->statement("UPDATE challenges SET state='consumed' WHERE id=?", [$challengeId]);
            $account = $this->statement('SELECT * FROM accounts WHERE email_key=? AND role=?', [$challenge['email_key'], 'parent'])->fetch();
            if (!$account) {
                if ($challenge['intent'] !== 'register') { return ['failure' => new ApiError(409, 'REGISTRATION_REQUIRED', 'Почта подтверждена. Заполните ФИО и телефон в разделе регистрации.')]; }
                $pending = json_decode($this->decrypt($challenge['pending_enc']), true, 8, JSON_THROW_ON_ERROR);
                $account = ['id' => $this->id(), 'role' => 'parent', 'email_enc' => $challenge['email_enc'], 'phone_enc' => $this->encrypt($pending['phone']), 'name_enc' => $this->encrypt($pending['fullName'])];
                $this->statement('INSERT INTO accounts(id,role,email_key,email_enc,phone_enc,name_enc,created_at) VALUES(?,?,?,?,?,?,?)', [$account['id'], 'parent', $challenge['email_key'], $account['email_enc'], $account['phone_enc'], $account['name_enc'], $now]);
            }
            // Re-registering a verified existing mailbox never replaces its profile or children.
            $this->statement('DELETE FROM sessions WHERE account_id=? AND expires_at<=?', [$account['id'], $now]);
            $this->statement('DELETE FROM sessions WHERE account_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE account_id=? ORDER BY created_at DESC,token_hash LIMIT 2)', [$account['id'], $account['id']]);
            $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
            $this->statement('INSERT INTO sessions(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)', [$this->hash('session:' . $token), $account['id'], $now, $now + 1800]);
            $this->audit('parent_login', $account['id']);
            return ['token' => $token, 'expiresAt' => $this->iso($now + 1800), 'account' => $this->accountView($account), 'children' => $this->children($account['id'])];
        });
        if (isset($result['failure'])) { throw $result['failure']; }
        return $result;
    }
    public function authenticate(string $token): array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/D', $token)) { throw new ApiError(401, 'UNAUTHORIZED', 'Войдите в личный кабинет.'); }
        $account = $this->statement('SELECT a.* FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>?', [$this->hash('session:' . $token), $this->now()])->fetch();
        if (!$account) { throw new ApiError(401, 'UNAUTHORIZED', 'Сеанс завершён. Войдите снова.'); }
        return $account;
    }
    private function role(array $account, string $role): void
    { if (($account['role'] ?? '') !== $role) { throw new ApiError(403, 'FORBIDDEN', 'Это действие недоступно в данном кабинете.'); } }
    private function accountView(array $account): array
    {
        $phone = $this->decrypt($account['phone_enc']);
        return ['id' => $account['id'], 'role' => $account['role'], 'displayName' => $this->decrypt($account['name_enc']),
            'emailMasked' => $account['email_enc'] ? $this->maskedEmail($this->decrypt($account['email_enc'])) : '',
            'phoneMasked' => '+7 ••• •••-' . substr($phone, -4, 2) . '-' . substr($phone, -2), 'phoneVerified' => false];
    }
    public function me(array $account): array
    { return ['account' => $this->accountView($account), 'children' => $account['role'] === 'parent' ? $this->children($account['id']) : []]; }
    public function logout(string $token, array $account): array
    { $this->statement('DELETE FROM sessions WHERE token_hash=?', [$this->hash('session:' . $token)]); $this->audit('logout', $account['id']); return ['ok' => true]; }
    private function date(mixed $date): string
    {
        if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)) { throw new ApiError(422, 'INVALID_DATE', 'Укажите корректную дату.'); }
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date, $this->timezone);
        if (!$parsed || $parsed->format('Y-m-d') !== $date || $date < '1900-01-01' || $date > $this->today()) { throw new ApiError(422, 'INVALID_DATE', 'Дата должна быть не позже сегодняшнего дня.'); }
        return $date;
    }
    private function month(mixed $month): string
    {
        if ($month === null || $month === '') { return substr($this->today(), 0, 7); }
        if (!is_string($month) || !preg_match('/^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$/D', $month)) { throw new ApiError(422, 'INVALID_MONTH', 'Укажите месяц в формате ГГГГ-ММ.'); }
        return $month;
    }
    private function childView(array $row): array
    {
        $doctors = array_map(fn(array $doctor): array => ['id' => $doctor['id'], 'displayName' => $this->decrypt($doctor['name_enc'])],
            $this->statement('SELECT a.id,a.name_enc FROM accounts a JOIN doctor_assignments d ON d.doctor_id=a.id WHERE d.child_id=? AND a.role=? ORDER BY d.assigned_at,a.id', [$row['id'], 'doctor'])->fetchAll());
        return ['id' => $row['id'], 'name' => $this->decrypt($row['name_enc']), 'birthDate' => $this->decrypt($row['birth_enc']),
            'relationship' => $row['relationship'] ?? 'parent', 'linkStatus' => 'unverified', 'doctorIds' => array_column($doctors, 'id'),
            'doctorAssignment' => ['status' => $doctors ? 'assigned' : 'unassigned', 'doctors' => $doctors]];
    }
    private function children(string $accountId): array
    { return array_map(fn(array $row): array => $this->childView($row), $this->statement('SELECT c.*,m.relationship FROM children c JOIN memberships m ON m.child_id=c.id WHERE m.account_id=? ORDER BY c.created_at,c.id', [$accountId])->fetchAll()); }
    private function childAccess(array $account, mixed $childId): array
    {
        $this->role($account, 'parent');
        if (!is_string($childId) || !preg_match('/^[a-f0-9]{32}$/D', $childId)) { throw new ApiError(404, 'NOT_FOUND', 'Профиль не найден.'); }
        $row = $this->statement('SELECT c.*,m.relationship FROM children c JOIN memberships m ON m.child_id=c.id WHERE c.id=? AND m.account_id=?', [$childId, $account['id']])->fetch();
        if (!$row) { throw new ApiError(404, 'NOT_FOUND', 'Профиль не найден.'); }
        return $row;
    }
    public function createChild(array $account, array $input): array
    {
        $this->role($account, 'parent'); $this->fields($input, ['name', 'birthDate', 'relationship']);
        $name = $this->text($input['name'] ?? null, 100);
        $birth = ($input['birthDate'] ?? '') === '' ? '' : $this->date($input['birthDate']);
        $relation = $input['relationship'] ?? '';
        if (!in_array($relation, self::RELATIONS, true)) { throw new ApiError(422, 'INVALID_RELATIONSHIP', 'Выберите вашу связь с ребёнком.'); }
        $id = $this->id();
        $this->transaction(function () use ($account, $name, $birth, $relation, $id): void {
            if ((int)$this->statement('SELECT COUNT(*) FROM memberships WHERE account_id=?', [$account['id']])->fetchColumn() >= 12) { throw new ApiError(422, 'CHILD_LIMIT', 'Для добавления ещё одного профиля обратитесь в клинику.'); }
            $this->statement('INSERT INTO children(id,name_enc,birth_enc,created_at) VALUES(?,?,?,?)', [$id, $this->encrypt($name), $this->encrypt($birth), $this->now()]);
            $this->statement('INSERT INTO memberships(account_id,child_id,relationship) VALUES(?,?,?)', [$account['id'], $id, $relation]);
            $this->audit('child_created', $account['id'], $id);
        });
        return ['child' => $this->childView($this->childAccess($account, $id))];
    }
    public function garden(array $account, mixed $childId, mixed $month): array
    { $this->childAccess($account, $childId); return $this->gardenMonth($childId, $this->month($month)); }
    private function gardenMonth(string $childId, string $month): array
    {
        $entries = []; $updated = null;
        foreach ($this->statement('SELECT entry_date,data_enc,updated_at FROM garden_entries WHERE child_id=? AND entry_date LIKE ? ORDER BY entry_date', [$childId, $month . '-%'])->fetchAll() as $row) {
            $entries[$row['entry_date']] = json_decode($this->decrypt($row['data_enc']), true, 16, JSON_THROW_ON_ERROR);
            $updated = max($updated ?? 0, (int)$row['updated_at']);
        }
        $plan = $this->statement('SELECT data_enc,updated_at FROM recommendations WHERE child_id=?', [$childId])->fetch();
        return ['garden' => ['entries' => $entries ?: new \stdClass(), 'goals' => [], 'updatedAt' => $updated === null ? null : $this->iso($updated),
            'recommendations' => $plan ? json_decode($this->decrypt($plan['data_enc']), false, 16, JSON_THROW_ON_ERROR) : new \stdClass(),
            'recommendationsUpdatedAt' => $plan ? $this->iso((int)$plan['updated_at']) : null]];
    }
    public function saveGarden(array $account, mixed $childId, array $input): array
    {
        $this->role($account, 'parent'); $this->fields($input, ['date', 'entry']); $date = $this->date($input['date'] ?? null); $entry = $input['entry'] ?? null;
        if (!is_array($entry) || (array_is_list($entry) && $entry !== [])) { throw new ApiError(422, 'INVALID_ENTRY', 'Проверьте отметки дневника.'); }
        foreach ($entry as $key => $value) {
            if (!in_array($key, array_merge(self::MARKS, ['note']), true) || ($key !== 'note' && $value !== null && !in_array($value, ['done', 'partial', 'missed'], true))) { throw new ApiError(422, 'INVALID_ENTRY', 'Проверьте отметки дневника.'); }
        }
        if (array_key_exists('note', $entry)) { $entry['note'] = $this->text($entry['note'], 1200, true, true); }
        $this->transaction(function () use ($account, $childId, $date, $entry): void {
            $child = $this->childAccess($account, $childId); $birth = $this->decrypt($child['birth_enc']);
            if ($birth !== '' && $date < $birth) { throw new ApiError(422, 'INVALID_DATE', 'Дата дневника не может быть раньше рождения ребёнка.'); }
            $saved = $this->statement('SELECT data_enc FROM garden_entries WHERE child_id=? AND entry_date=?', [$childId, $date])->fetchColumn();
            $current = $saved === false ? [] : json_decode($this->decrypt($saved), true, 16, JSON_THROW_ON_ERROR);
            foreach ($entry as $key => $value) { if ($value === null || ($key === 'note' && $value === '')) { unset($current[$key]); } else { $current[$key] = $value; } }
            if (!$current) { $this->statement('DELETE FROM garden_entries WHERE child_id=? AND entry_date=?', [$childId, $date]); }
            else { $this->statement('INSERT INTO garden_entries(child_id,entry_date,data_enc,updated_at) VALUES(?,?,?,?) ON CONFLICT(child_id,entry_date) DO UPDATE SET data_enc=excluded.data_enc,updated_at=excluded.updated_at', [$childId, $date, $this->encrypt(json_encode($current, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)), $this->now()]); }
            $this->audit('garden_saved', $account['id'], $childId);
        });
        return $this->gardenMonth($childId, substr($date, 0, 7));
    }
    private function doctorAccess(array $account, mixed $childId): void
    {
        $this->role($account, 'doctor');
        if (!is_string($childId) || !preg_match('/^[a-f0-9]{32}$/D', $childId) || !$this->statement('SELECT 1 FROM doctor_assignments WHERE doctor_id=? AND child_id=?', [$account['id'], $childId])->fetchColumn()) { throw new ApiError(404, 'NOT_FOUND', 'Пациент не прикреплён к этому врачу.'); }
    }
    public function doctorChildren(array $account): array
    {
        $this->role($account, 'doctor');
        $rows = $this->statement('SELECT c.* FROM children c JOIN doctor_assignments d ON d.child_id=c.id WHERE d.doctor_id=? ORDER BY c.created_at,c.id', [$account['id']])->fetchAll();
        return ['children' => array_map(fn(array $row): array => $this->childView($row), $rows)];
    }
    public function doctorGarden(array $account, mixed $childId, mixed $month): array
    { $this->doctorAccess($account, $childId); $this->audit('doctor_garden_viewed', $account['id'], $childId); return $this->gardenMonth($childId, $this->month($month)); }
    public function doctorRecommendations(array $account, mixed $childId, array $input): array
    {
        $this->role($account, 'doctor'); $this->fields($input, ['recommendations']); $patch = $input['recommendations'] ?? null;
        if (!is_array($patch) || (array_is_list($patch) && $patch !== [])) { throw new ApiError(422, 'INVALID_RECOMMENDATION', 'Проверьте рекомендации.'); }
        $this->fields($patch, self::MARKS);
        foreach ($patch as $key => $value) { $patch[$key] = $this->text($value, 1200, true, true); }
        return $this->transaction(function () use ($account, $childId, $patch): array {
            $this->doctorAccess($account, $childId);
            $saved = $this->statement('SELECT data_enc FROM recommendations WHERE child_id=?', [$childId])->fetchColumn();
            $current = $saved === false ? [] : json_decode($this->decrypt($saved), true, 16, JSON_THROW_ON_ERROR);
            foreach ($patch as $key => $value) { if ($value === '') { unset($current[$key]); } else { $current[$key] = $value; } }
            $now = $this->now();
            $this->statement('INSERT INTO recommendations(child_id,data_enc,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(child_id) DO UPDATE SET data_enc=excluded.data_enc,updated_by=excluded.updated_by,updated_at=excluded.updated_at', [$childId, $this->encrypt(json_encode((object)$current, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)), $account['id'], $now]);
            $this->audit('recommendations_saved', $account['id'], $childId);
            return ['recommendations' => (object)$current, 'updatedAt' => $this->iso($now)];
        });
    }
    public function documents(array $account, mixed $childId): array
    { $this->childAccess($account, $childId); return ['documents' => [], 'linkStatus' => 'not_connected']; }
    private function audit(string $event, ?string $accountId = null, ?string $childId = null): void
    { $this->statement('INSERT INTO audit(event,account_id,child_id,created_at) VALUES(?,?,?,?)', [$event, $accountId, $childId, $this->now()]); }
    private function requireCli(): void { if (PHP_SAPI !== 'cli') { throw new RuntimeException('CLI only'); } }
    public function operatorChildren(string $email): array
    {
        $this->requireCli();
        $account = $this->statement('SELECT * FROM accounts WHERE email_key=? AND role=?', [$this->hash('email:' . $this->normalizeEmail($email)), 'parent'])->fetch();
        if (!$account) { throw new RuntimeException('Verified parent account not found'); }
        return $this->me($account);
    }
    public function provisionDoctor(string $fullName, string $phone): array
    {
        $this->requireCli(); $name = $this->text($fullName, 150); $phone = $this->phone($phone); $id = $this->id();
        $this->statement('INSERT INTO accounts(id,role,phone_enc,name_enc,created_at) VALUES(?,?,?,?,?)', [$id, 'doctor', $this->encrypt($phone), $this->encrypt($name), $this->now()]);
        $this->audit('doctor_provisioned', $id);
        return ['doctorId' => $id, 'signInEnabled' => false];
    }
    public function assignDoctor(string $doctorId, string $childId, string $evidence): array
    {
        $this->requireCli(); $evidence = $this->text($evidence, 1000);
        return $this->transaction(function () use ($doctorId, $childId, $evidence): array {
            if (!$this->statement('SELECT 1 FROM accounts WHERE id=? AND role=?', [$doctorId, 'doctor'])->fetchColumn() || !$this->statement('SELECT 1 FROM children WHERE id=?', [$childId])->fetchColumn()) { throw new RuntimeException('Doctor or child not found'); }
            $this->statement('INSERT INTO doctor_assignments(doctor_id,child_id,evidence_enc,assigned_at) VALUES(?,?,?,?) ON CONFLICT(doctor_id,child_id) DO UPDATE SET evidence_enc=excluded.evidence_enc,assigned_at=excluded.assigned_at', [$doctorId, $childId, $this->encrypt($evidence), $this->now()]);
            $this->audit('doctor_assigned', $doctorId, $childId);
            return ['ok' => true];
        });
    }
    public function unassignDoctor(string $doctorId, string $childId): array
    {
        $this->requireCli();
        return $this->transaction(function () use ($doctorId, $childId): array {
            $this->statement('DELETE FROM doctor_assignments WHERE doctor_id=? AND child_id=?', [$doctorId, $childId]);
            $this->statement('DELETE FROM sessions WHERE account_id=?', [$doctorId]);
            $this->audit('doctor_unassigned', $doctorId, $childId);
            return ['ok' => true];
        });
    }
}
