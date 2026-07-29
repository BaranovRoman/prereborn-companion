import Image from "next/image";
import styles from "./queue-scene.module.scss";

const TREE_LAYERS = [
    {
        className: styles.treeFar,
        src: "/vendor/origin-unknown/trees-1.png",
        testId: "queue-tree-far",
    },
    {
        className: styles.treeMiddle,
        src: "/vendor/origin-unknown/trees-2.png",
        testId: "queue-tree-middle",
    },
    {
        className: styles.treeNear,
        src: "/vendor/origin-unknown/trees-3.png",
        testId: "queue-tree-near",
    },
] as const;

export const QueueTreeLayers = () => (
    <div className={styles.treeStage} aria-hidden="true">
        <div
            className={`${styles.treeLayer} ${styles.treeDistantSilhouette}`}
            data-testid="queue-tree-distant-silhouette"
        >
            <Image
                className={styles.treeImage}
                src="/vendor/origin-unknown/trees-2.png"
                alt=""
                fill
                priority
                sizes="78vw"
            />
        </div>

        {TREE_LAYERS.map(({ className, src, testId }) => (
            <div
                key={src}
                className={`${styles.treeLayer} ${className}`}
                data-testid={testId}
            >
                <Image
                    className={styles.treeImage}
                    src={src}
                    alt=""
                    fill
                    priority
                    sizes="100vw"
                />
            </div>
        ))}

        <div className={styles.treeFogMiddle} />
        <div className={styles.treeFogFront} />
    </div>
);
