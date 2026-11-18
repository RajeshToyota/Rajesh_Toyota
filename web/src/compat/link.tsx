import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
};

// next/link's <Link href> on top of react-router. External links stay plain anchors.
export default function Link({ href, prefetch: _p, scroll: _s, replace, ...rest }: Props) {
  if (/^(https?:|mailto:|tel:)/.test(href)) return <a href={href} {...rest} />;
  return <RouterLink to={href} replace={replace} {...rest} />;
}
(Link as unknown as { __client: boolean }).__client = true;
