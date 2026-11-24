<?php
declare(strict_types=1);

// Copy outside the web root. Real keys and mail credentials NEVER belong in GitHub.
return [
    'enabled' => false,
    'public_root' => '/home/ACCOUNT/cabinet.vash-doc.ru/public_html',
    'private_dir' => '/home/ACCOUNT/private/vd-cabinet', // Existing directory, mode 0700.
    'allowed_origins' => ['https://cabinet.vash-doc.ru'], // Example: configure this dedicated origin separately.
    'secret' => 'REPLACE_WITH_64_RANDOM_HEX_CHARACTERS',
    'encryption_key' => 'REPLACE_WITH_BASE64_ENCODED_32_RANDOM_BYTES',
    'smtp_host' => 'smtp.example.invalid',
    'smtp_port' => 465,
    'smtp_security' => 'smtps', // smtps (implicit TLS) or starttls (TLS REQUIRED).
    'smtp_username' => 'REPLACE_WITH_SMTP_USERNAME',
    'smtp_password' => 'REPLACE_WITH_PRIVATE_SMTP_PASSWORD',
    'smtp_from' => 'no-reply@example.invalid', // Verified sender on the clinic mail service.
    'email_hour_limit' => 100,
    'email_day_limit' => 300,
];
