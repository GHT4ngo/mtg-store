import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

interface CardImageHoverProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
}

export default function CardImageHover({ src, alt = "", children }: CardImageHoverProps) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        sideOffset={8}
        className="w-[250px] p-1 bg-popover border border-border shadow-xl rounded-lg"
      >
        <img
          src={src}
          alt={alt}
          className="w-full rounded-md"
          style={{ aspectRatio: "5/7" }}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
