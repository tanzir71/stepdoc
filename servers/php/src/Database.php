<?php
declare(strict_types=1);
namespace StepDoc;

final class Database
{
    public readonly \PDO $pdo;
    private int $depth = 0;
    public function __construct(public readonly Config $config)
    {
        $this->pdo = new \PDO('sqlite:' . $config->dataDir . '/stepdoc.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
        $this->pdo->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
        $this->transaction(function (): void {
            $this->pdo->exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
            if (!$this->one('SELECT version FROM migrations WHERE version=1')) {
                $this->pdo->exec(file_get_contents(__DIR__ . '/../migrations/001-storage.sql'));
                $this->execute('INSERT INTO migrations VALUES(1,?)', [self::now()]);
            }
            if (!$this->one('SELECT version FROM migrations WHERE version=2')) {
                $this->pdo->exec(file_get_contents(__DIR__ . '/../migrations/002-auth.sql'));
                $this->execute('INSERT INTO migrations VALUES(2,?)', [self::now()]);
            }
            if (!$this->one('SELECT version FROM migrations WHERE version=3')) {
                $this->pdo->exec(file_get_contents(__DIR__ . '/../migrations/003-captures.sql'));
                $this->execute('INSERT INTO migrations VALUES(3,?)', [self::now()]);
            }
        });
        @chmod($config->dataDir . '/stepdoc.sqlite', 0600);
    }
    public static function now(): string
    {
        $now = microtime(true);
        return gmdate('Y-m-d\TH:i:s', (int) $now) . sprintf('.%03dZ', (int) floor(($now - floor($now)) * 1000));
    }
    public static function id(): string { return bin2hex(random_bytes(16)); }
    public function execute(string $sql, array $params = []): \PDOStatement
    {
        $statement = $this->pdo->prepare($sql);
        $statement->execute($params);
        return $statement;
    }
    public function one(string $sql, array $params = []): ?array { return $this->execute($sql, $params)->fetch() ?: null; }
    public function transaction(callable $work): mixed
    {
        $level = $this->depth;
        $savepoint = 'stepdoc_' . $level;
        $this->pdo->exec($level === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' . $savepoint);
        $this->depth++;
        try {
            $result = $work();
            $this->pdo->exec($level === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' . $savepoint);
            return $result;
        } catch (\Throwable $error) {
            $this->pdo->exec($level === 0 ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT ' . $savepoint);
            if ($level !== 0) $this->pdo->exec('RELEASE SAVEPOINT ' . $savepoint);
            throw $error;
        } finally { $this->depth--; }
    }
    public function audit(string $workspace, string $actor, string $action, string $subject): void
    {
        $this->execute('INSERT INTO audit_log VALUES(?,?,?,?,?,?,?)', [self::id(), $workspace, $actor, $action, $subject, '{}', self::now()]);
    }
}
