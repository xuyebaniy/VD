<?php
declare(strict_types=1);

namespace VashDoctor;

use RuntimeException;

/** Authenticated SMTP using libcurl; no mail(), plaintext fallback, logs, or test switch. */
class SmtpSender
{
    public function send(array $config, string $email, string $code): void
    {
        $from = $config['smtp_from'];
        // Both addresses are strictly validated again at this transport boundary.
        foreach ([$from, $email] as $address) {
            if (!is_string($address) || !filter_var($address, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n<>\x00]/', $address)) {
                throw new RuntimeException('Invalid mail address');
            }
        }
        if (!preg_match('/^[0-9]{6}$/D', $code)) { throw new RuntimeException('Invalid code'); }
        $domain = substr($from, strrpos($from, '@') + 1);
        $body = 'Ваш Доктор: код входа ' . $code . ".\r\n\r\nКод действует 10 минут. Не сообщайте его никому.\r\nЕсли вы не запрашивали вход, просто проигнорируйте это письмо.\r\n";
        $message = 'Date: ' . gmdate('D, d M Y H:i:s +0000') . "\r\n" .
            'From: =?UTF-8?B?' . base64_encode('Ваш Доктор') . '?= <' . $from . ">\r\n" .
            'To: <' . $email . ">\r\n" .
            'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $domain . ">\r\n" .
            'Subject: =?UTF-8?B?' . base64_encode('Код входа в Ваш Доктор') . "?=\r\n" .
            "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" .
            chunk_split(base64_encode($body), 76, "\r\n");
        $stream = fopen('php://temp', 'w+b');
        if ($stream === false || fwrite($stream, $message) !== strlen($message)) { throw new RuntimeException('Cannot prepare message'); }
        rewind($stream);
        $scheme = $config['smtp_security'] === 'smtps' ? 'smtps' : 'smtp';
        $options = [
            CURLOPT_URL => $scheme . '://' . $config['smtp_host'] . ':' . $config['smtp_port'],
            CURLOPT_USERNAME => $config['smtp_username'], CURLOPT_PASSWORD => $config['smtp_password'],
            CURLOPT_MAIL_FROM => '<' . $from . '>', CURLOPT_MAIL_RCPT => ['<' . $email . '>'],
            CURLOPT_UPLOAD => true, CURLOPT_INFILE => $stream, CURLOPT_INFILESIZE => strlen($message),
            CURLOPT_USE_SSL => CURLUSESSL_ALL, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_SMTP | CURLPROTO_SMTPS, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 20, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_VERBOSE => false,
        ];
        try {
            [$accepted, $responseCode] = $this->transfer($options);
            if (!$accepted || $responseCode < 200 || $responseCode >= 300) { throw new RuntimeException('SMTP did not accept message'); }
        } finally { fclose($stream); }
    }

    protected function transfer(array $options): array
    {
        $curl = curl_init();
        if ($curl === false) { throw new RuntimeException('SMTP transport unavailable'); }
        try {
            if (!curl_setopt_array($curl, $options)) { throw new RuntimeException('SMTP configuration rejected'); }
            $result = curl_exec($curl);
            return [$result !== false, (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE)];
        } finally { curl_close($curl); }
    }
}
