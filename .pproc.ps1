
$p=Get-Process -Name 'claude' -ErrorAction SilentlyContinue
if(!$p){'[]'}else{
 $p|%{[PSCustomObject]@{Id=$_.Id;CPU=[math]::Round($_.CPU,1);
  Mem=[math]::Round($_.WorkingSet64/1MB,1);
  Start=$_.StartTime.ToString('HH:mm:ss');
  UpM=[math]::Round(((Get-Date)-$_.StartTime).TotalMinutes,1);
  Threads=$_.Threads.Count}}|ConvertTo-Json -Compress}
