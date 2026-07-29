import styles from "./json-tree.module.scss";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const renderPrimitive = (value: unknown) => {
    if (value === null) return <span className={styles.null}>null</span>;
    if (typeof value === "string") {
        return <span className={styles.string}>&quot;{value}&quot;</span>;
    }
    if (typeof value === "number") {
        return <span className={styles.number}>{value}</span>;
    }
    if (typeof value === "boolean") {
        return <span className={styles.boolean}>{String(value)}</span>;
    }
    return <span className={styles.null}>{String(value)}</span>;
};

interface JsonNodeProps {
    value: unknown;
    depth: number;
}

// Ручной recursive-рендер JSON без внешней библиотеки (задача явно просит
// не подключать тяжёлый JSON-viewer ради этого) - полностью развёрнутое
// дерево (без collapse/expand-состояния), т.к. это read-only debug-вывод,
// а не интерактивный редактор. Скролл и ограничение высоты - в
// debug-panel.module.scss на обёртке, не здесь.
const JsonNode = ({ value, depth }: JsonNodeProps) => {
    if (Array.isArray(value)) {
        if (value.length === 0) return <span className={styles.punct}>[]</span>;
        return (
            <>
                <span className={styles.punct}>[</span>
                {value.map((item, index) => (
                    <div
                        key={index}
                        className={styles.line}
                        style={{ paddingLeft: (depth + 1) * 14 }}
                    >
                        <JsonNode value={item} depth={depth + 1} />
                        {index < value.length - 1 && (
                            <span className={styles.punct}>,</span>
                        )}
                    </div>
                ))}
                <div className={styles.line} style={{ paddingLeft: depth * 14 }}>
                    <span className={styles.punct}>]</span>
                </div>
            </>
        );
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) return <span className={styles.punct}>{"{}"}</span>;
        return (
            <>
                <span className={styles.punct}>{"{"}</span>
                {entries.map(([key, val], index) => (
                    <div
                        key={key}
                        className={styles.line}
                        style={{ paddingLeft: (depth + 1) * 14 }}
                    >
                        <span className={styles.key}>&quot;{key}&quot;</span>
                        <span className={styles.punct}>: </span>
                        <JsonNode value={val} depth={depth + 1} />
                        {index < entries.length - 1 && (
                            <span className={styles.punct}>,</span>
                        )}
                    </div>
                ))}
                <div className={styles.line} style={{ paddingLeft: depth * 14 }}>
                    <span className={styles.punct}>{"}"}</span>
                </div>
            </>
        );
    }

    return renderPrimitive(value);
};

export const JsonTree = ({ value }: { value: unknown }) => (
    <div className={styles.tree}>
        <JsonNode value={value} depth={0} />
    </div>
);
