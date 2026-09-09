import styles from "./ListPriceNote.module.css";

export interface ListPriceNoteProps {
  /** docs/copy.md `product.list_price_note`: "Liste fiyatı {gün} gün önce {tutar} idi." */
  text: string;
}

/** docs/pages.md "Sahte indirim notu": list_price_inflated ise, notr dille. */
export function ListPriceNote({ text }: ListPriceNoteProps) {
  return <p className={styles.note}>{text}</p>;
}
