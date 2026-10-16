//! Bounded media classification shared by native import and the owning worker.
//! This is not a decoder, a file path grant or an IPC operation.
pub fn image_mime(bytes:&[u8])->Option<&'static str>{
 if bytes.starts_with(b"\x89PNG\r\n\x1a\n"){Some("image/png")}
 else if bytes.starts_with(&[0xff,0xd8,0xff]){Some("image/jpeg")}
 else if bytes.len()>12&&bytes.starts_with(b"RIFF")&&&bytes[8..12]==b"WEBP"{Some("image/webp")}
 else{None}
}
#[cfg(test)]mod tests{use super::*;#[test]fn supported_images_are_not_an_html_or_svg_import(){
 assert_eq!(image_mime(b"\x89PNG\r\n\x1a\ndata"),Some("image/png"));assert_eq!(image_mime(&[0xff,0xd8,0xff,1]),Some("image/jpeg"));assert_eq!(image_mime(b"RIFFxxxxWEBPdata"),Some("image/webp"));
 for bytes in [b"<svg onload=bad>".as_slice(),b"<html>",b"RIFFxxxxWAVEdata",b""]{assert_eq!(image_mime(bytes),None);}
}}
